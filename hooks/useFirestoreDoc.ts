import { useState, useEffect, useCallback, useRef } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '../services/firebase';
import { stripUndefinedDeep } from '../services/firestoreSanitize';
import { enqueueWrites } from '../services/offlineQueue';

/**
 * Like useFirestoreArray, but for a single settings-style document (e.g. a
 * map of RM opening balances) rather than a collection of records. Behaves
 * like useState — reads live, writes go straight to Firestore.
 */
export function useFirestoreDoc<T extends Record<string, any>>(
  collectionName: string,
  docId: string,
  defaultValue: T
): [T, (update: T | ((prev: T) => T)) => void] {
  const [data, setDataLocal] = useState<T>(defaultValue);
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

  return [data, setData];
}
