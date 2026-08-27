import { doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from './firebase';

// ============================================================
// Offline / quota-outage write queue
// ============================================================
// useFirestoreArray and useFirestoreDoc already only ever write the
// specific documents that actually changed (never the whole collection).
// This module is the safety net for when even that small write fails —
// e.g. Firestore's daily quota is exhausted, or the device has no network.
//
// Instead of the change silently vanishing (the previous behavior — see
// the console.error-only .catch() this replaces), the exact failed
// document(s) are saved into this browser's localStorage — nothing else,
// never a snapshot of parts/sales/customers/etc. — and retried
// automatically in the background. The moment a queued entry uploads
// successfully, it is deleted from this local queue immediately.
//
// Scope/limits worth knowing: this queue lives in ONE browser's local
// storage, so it only helps if that same device/browser is reopened again
// after the outage clears (auto-flush also runs once immediately on every
// app load, so simply reopening the tab is enough — no manual action
// needed). Clearing that browser's site data would also clear anything
// still queued, same as any other unsynced browser data.
// ============================================================

const STORAGE_KEY = 'erp_pending_writes_v1';

export interface QueuedWrite {
  key: string; // `${collectionName}/${docId}` — used to dedupe
  collectionName: string;
  docId: string;
  op: 'set' | 'delete';
  data?: any;
  queuedAt: string;
}

type NewWrite = Omit<QueuedWrite, 'key' | 'queuedAt'>;

function readQueue(): QueuedWrite[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedWrite[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (err) {
    console.error('[OfflineQueue] Could not persist pending-write queue (browser storage may be full):', err);
  }
}

type QueueEvent =
  | { type: 'queued'; justQueuedCount: number; pendingCount: number }
  | { type: 'flushed'; flushedCount: number; pendingCount: number };

type Listener = (e: QueueEvent) => void;
const listeners = new Set<Listener>();

/** Lets the UI show a toast when something gets queued or successfully uploads, without polling. */
export function subscribeQueueEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(e: QueueEvent) {
  listeners.forEach((l) => l(e));
}

/**
 * Called only from useFirestoreArray/useFirestoreDoc after a real Firestore
 * write has already failed. `entries` is exactly the small set of documents
 * that were part of that one failed write — never the whole collection.
 * If a document is queued again before its earlier queued copy has
 * uploaded, the newer version replaces the older one (never stacked), so
 * the queue only ever holds the latest pending version of each document.
 */
export function enqueueWrites(entries: NewWrite[]) {
  if (entries.length === 0) return;
  const queue = readQueue();
  const byKey = new Map(queue.map((w) => [w.key, w]));
  entries.forEach((entry) => {
    const key = `${entry.collectionName}/${entry.docId}`;
    byKey.set(key, { ...entry, key, queuedAt: new Date().toISOString() });
  });
  const next = Array.from(byKey.values());
  writeQueue(next);
  emit({ type: 'queued', justQueuedCount: entries.length, pendingCount: next.length });
}

export function getPendingCount(): number {
  return readQueue().length;
}

let flushing = false;

/**
 * Attempts to (re)send every queued entry to Firestore. Anything that
 * uploads successfully is removed from the queue immediately; anything
 * that still fails (outage/quota still in effect) is left queued for the
 * next attempt. Safe to call often — a call that overlaps a run already in
 * progress is a no-op.
 */
export async function flushPendingWrites(): Promise<{ flushed: number; remaining: number }> {
  if (flushing) return { flushed: 0, remaining: getPendingCount() };
  const queue = readQueue();
  if (queue.length === 0) return { flushed: 0, remaining: 0 };

  flushing = true;
  try {
    let flushed = 0;
    const stillPending: QueuedWrite[] = [];

    for (const entry of queue) {
      try {
        if (entry.op === 'delete') {
          await deleteDoc(doc(db, entry.collectionName, entry.docId));
        } else {
          await setDoc(doc(db, entry.collectionName, entry.docId), entry.data || {});
        }
        flushed++;
      } catch {
        // Still failing — keep it queued, never dropped, try again later.
        stillPending.push(entry);
      }
    }

    writeQueue(stillPending);
    if (flushed > 0) {
      emit({ type: 'flushed', flushedCount: flushed, pendingCount: stillPending.length });
    }
    return { flushed, remaining: stillPending.length };
  } finally {
    flushing = false;
  }
}

/**
 * Call once near app startup. Retries automatically: immediately (covers
 * "the outage had already cleared while this device was closed"), every
 * `intervalMs` while the app stays open, and whenever the browser regains
 * a network connection. Returns a cleanup function.
 */
export function startOfflineQueueAutoFlush(intervalMs = 60000): () => void {
  flushPendingWrites();
  const timer = setInterval(() => {
    flushPendingWrites();
  }, intervalMs);
  const onOnline = () => {
    flushPendingWrites();
  };
  window.addEventListener('online', onOnline);
  return () => {
    clearInterval(timer);
    window.removeEventListener('online', onOnline);
  };
}
