import { useState, useEffect, useRef, useCallback } from 'react';
import { collection, onSnapshot, doc, writeBatch } from 'firebase/firestore';
import { db } from '../services/firebase';
import { stripUndefinedDeep } from '../services/firestoreSanitize';
import { enqueueWrites } from '../services/offlineQueue';

// 10-Oct-26 — before this, a failed batch.commit() below only hit
// console.error: invisible to anyone not already staring at that exact
// browser's DevTools at that exact moment. That's exactly how a real gate-
// photo entry's invoice/dharamkanta photos silently vanished (Banke Bihari
// Steel Traders, 9-Oct-26, oversized document — see services/
// apiHandlers.ts's GATE_PHOTO_MAX_RAW_BYTES) — Store's own browser showed
// it as saved (the optimistic local update below always applies regardless
// of whether the real write succeeds), the write itself failed server-side,
// and nobody found out until Admin reviewed it later on a different
// device. This is a tiny pub/sub of exactly one subscriber: App.tsx
// registers a single handler once (wired to pushAdminAlert, so a failure
// shows up in Notifications for Admin on any device) via
// setFirestoreWriteErrorHandler, and every useFirestoreArray instance for
// every collection in the app calls it on a failed write. Deliberately a
// module-level variable rather than a parameter threaded through all 16+
// useFirestoreArray call sites — one registration covers all of them.
let writeErrorHandler: ((collectionName: string, error: any) => void) | null = null;
export function setFirestoreWriteErrorHandler(handler: (collectionName: string, error: any) => void) {
  writeErrorHandler = handler;
}

/**
 * Keeps a React array in sync with a Firestore collection, live, across every
 * device that has this hook open — while looking exactly like useState() to
 * the rest of the app. Existing code that does setParts(prev => [...]) or
 * setSales(newArray) keeps working unchanged; under the hood, this diffs the
 * change against Firestore and writes only what actually changed.
 *
 * Requires every item to have a stable string `id` field — your app already
 * generates these (Math.random().toString(36)...) for parts/sales/etc.
 */
export function useFirestoreArray<T>(
  collectionName: string,
  seedIfEmpty: T[] = [],
  getId: (item: T) => string = (item: any) => item.id
): [T[], (update: T[] | ((prev: T[]) => T[])) => void] {
  const [data, setDataLocal] = useState<T[]>([]);
  const dataRef = useRef<T[]>([]);
  const seededRef = useRef(false);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, collectionName),
      (snap) => {
        const next = snap.docs.map((d) => ({ ...(d.data() as any) } as T));
        // One-time seed: if this is the very first sync and Firestore is
        // genuinely empty, push the starting dataset (e.g. INITIAL_PARTS)
        // so a brand-new deployment isn't blank. Never re-seeds after that.
        if (next.length === 0 && seedIfEmpty.length > 0 && !seededRef.current) {
          seededRef.current = true;
          const batch = writeBatch(db);
          seedIfEmpty.forEach((item) => batch.set(doc(db, collectionName, getId(item)), item as any));
          batch.commit().catch((err) => console.error(`Seed failed for ${collectionName}:`, err));
          setDataLocal(seedIfEmpty);
        } else {
          seededRef.current = true;
          setDataLocal(next);
        }
      },
      (err) => console.error(`Firestore subscription failed for ${collectionName}:`, err)
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName]);

  const setData = useCallback(
    (update: T[] | ((prev: T[]) => T[])) => {
      const prev = dataRef.current;
      const next = typeof update === 'function' ? (update as (p: T[]) => T[])(prev) : update;

      // Optimistic local update so the UI feels instant; the onSnapshot
      // listener above will reconcile shortly after with the server truth.
      setDataLocal(next);
      // 26-Sep-26 bug fix: dataRef.current used to only get refreshed by the
      // `useEffect(() => { dataRef.current = data }, [data])` above, which
      // doesn't run until AFTER this render commits. That's a full tick too
      // late for a caller that fires the setter twice back-to-back in the
      // same synchronous handler (e.g. App.tsx's finalizeGateDocument: push
      // a brand-new PendingRMEntry via setPendingRMEntries, then immediately
      // patch it with the gate photo/slip photo via a second
      // setPendingRMEntries call). The second call's `prev` was still the
      // pre-push array, so `.map()` never found the just-created id and the
      // patch silently no-op'd — the entry posted fine but its photo(s)
      // never landed. Setting the ref synchronously here closes that gap for
      // every caller of every setter this hook returns, not just this one
      // call site.
      dataRef.current = next;

      const nextIds = new Set(next.map((n) => getId(n)));
      const batch = writeBatch(db);
      let opCount = 0;
      // Mirrors exactly what goes into the batch below — so that IF the
      // commit fails (Firestore quota exhausted, device offline, etc.) we
      // know precisely which small set of documents to hand to the offline
      // queue for automatic retry. Never the whole collection — just these.
      const pendingWrites: { collectionName: string; docId: string; op: 'set' | 'delete'; data?: any }[] = [];
      next.forEach((item) => {
        const id = getId(item);
        const prevItem = prev.find((p) => getId(p) === id);
        if (!prevItem || JSON.stringify(prevItem) !== JSON.stringify(item)) {
          // Strip `undefined` fields right before the write — Firestore
          // rejects them outright (throws synchronously), which used to
          // surface as "Something went wrong while posting this entry" on
          // an otherwise completely valid submission. See
          // services/firestoreSanitize.ts.
          const sanitized = stripUndefinedDeep(item) as any;
          batch.set(doc(db, collectionName, id), sanitized);
          pendingWrites.push({ collectionName, docId: id, op: 'set', data: sanitized });
          opCount++;
        }
      });
      prev.forEach((item) => {
        const id = getId(item);
        if (!nextIds.has(id)) {
          batch.delete(doc(db, collectionName, id));
          pendingWrites.push({ collectionName, docId: id, op: 'delete' });
          opCount++;
        }
      });
      if (opCount > 0) {
        batch.commit().catch((err) => {
          console.error(`Firestore write failed for ${collectionName}:`, err);
          // The optimistic update above already shows this on screen — don't
          // let it silently vanish. Queue exactly what failed so it uploads
          // automatically as soon as Firestore is reachable again.
          enqueueWrites(pendingWrites);
          // ALSO surface it where a human can actually see it — see the
          // 10-Oct-26 comment above setFirestoreWriteErrorHandler. The
          // offline-queue retry above only helps a transient/offline
          // failure; it does nothing for a write that fails for a reason
          // that'll fail again on retry too (e.g. a document over
          // Firestore's 1 MiB limit) — this is what catches that case.
          writeErrorHandler?.(collectionName, err);
        });
      }
    },
    [collectionName]
  );

  return [data, setData];
}
