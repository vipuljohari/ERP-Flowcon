import { useState, useEffect, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { stripUndefinedDeep } from '../services/firestoreSanitize';
import { enqueueWrites } from '../services/offlineQueue';

/**
 * Like useFirestoreArray, but for a single settings-style document (e.g. a
 * map of RM opening balances) rather than a collection of records. Behaves
 * like useState — reads live, writes go straight to Firestore.
 *
 * Third return value: `loaded` — false until the FIRST real onSnapshot
 * callback has arrived (whether or not the document actually exists yet).
 * Until then, `data` is just this hook's not-yet-synced `defaultValue`
 * (usually `{}`), which looks IDENTICAL to "the document is genuinely
 * empty." Any caller that scans `data` to decide what to write back —
 * e.g. "fill in every key that's missing" — MUST wait for `loaded` before
 * doing that, or it will treat every real, already-stored key as "missing"
 * on a render that simply beat the Firestore listener, and then overwrite
 * the whole document (this hook's setter does a full replace, not a
 * per-field merge) with a reconstructed map that's missing everything that
 * hadn't loaded yet. This was a real bug (10-Sep-26): App.tsx's Opening
 * Balance auto-freeze effect ran before rmOpeningBalances/
 * partOpeningBalances had loaded, saw every item as "missing" a current-
 * month override, and wiped out real stored corrections (including
 * same-day pencil-edits) with freshly re-simulated values. Fixed by gating
 * that effect on this flag — see App.tsx.
 */
export function useFirestoreDoc<T extends Record<string, any>>(
  collectionName: string,
  docId: string,
  defaultValue: T
): [T, (update: T | ((prev: T) => T)) => void, boolean] {
  const [data, setDataLocal] = useState<T>(defaultValue);
  const [loaded, setLoaded] = useState(false);
  const dataRef = useRef<T>(defaultValue);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, collectionName, docId),
      (snap) => {
        if (snap.exists()) {
          setDataLocal(snap.data() as T);
        }
        // If it doesn't exist yet, keep the default — first write will create it.
        // Either way, this is now a confirmed real read of the document's
        // current server state — flip loaded so callers that need to tell
        // "not synced yet" apart from "genuinely empty" can safely proceed.
        setLoaded(true);
      },
      (err) => console.error(`Firestore doc subscription failed for ${collectionName}/${docId}:`, err)
    );
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionName, docId]);

  const setData = useCallback(
    (update: T | ((prev: T) => T)) => {
      const prev = dataRef.current;
      const next = typeof update === 'function' ? (update as (p: T) => T)(prev) : update;
      setDataLocal(next);
      // Same undefined-field guard as useFirestoreArray — see
      // services/firestoreSanitize.ts.
      const sanitized = stripUndefinedDeep(next);
      setDoc(doc(db, collectionName, docId), sanitized).catch((err) => {
        console.error(`Firestore doc write failed for ${collectionName}/${docId}:`, err);
        // Don't let this silently vanish — queue it for automatic retry.
        // See services/offlineQueue.ts.
        enqueueWrites([{ collectionName, docId, op: 'set', data: sanitized }]);
      });
    },
    [collectionName, docId]
  );

  return [data, setData, loaded];
}
