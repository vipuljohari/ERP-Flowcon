import { useState, useEffect, useRef, useCallback } from 'react';
import { collection, onSnapshot, doc, writeBatch } from 'firebase/firestore';
import { db } from '../services/firebase';
import { stripUndefinedDeep } from '../services/firestoreSanitize';
import { enqueueWrites } from '../services/offlineQueue';

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
        });
      }
    },
    [collectionName]
  );

  return [data, setData];
}
