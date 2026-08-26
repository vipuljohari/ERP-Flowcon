// Firestore's set()/setDoc() throw SYNCHRONOUSLY if any field is explicitly
// `undefined` (as opposed to simply absent) — a well-known SDK gotcha. This
// app's log/record builders routinely include a field like `remarks: rem`
// or `sheetSizeText` where the variable is legitimately `undefined` for the
// common case (a plain positive-qty inward with no remarks, a Tube RM with
// no sheet size) — e.g. App.tsx's handleAddRMInward. One call site already
// worked around this by hand (pushAdminAlert strips undefined itself), but
// that's easy to forget at any NEW call site, and at least two existing
// ones didn't do it — which is exactly what caused "Something went wrong
// while posting this entry" on an ordinary RM Inward submission.
//
// Fixing this once here, at the point every write actually goes through
// (useFirestoreArray / useFirestoreDoc), protects every collection and
// every future call site automatically, rather than relying on each one to
// remember to sanitize its own data.
export function stripUndefinedDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefinedDeep(v)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, any> = {};
    Object.entries(value as Record<string, any>).forEach(([k, v]) => {
      if (v === undefined) return;
      out[k] = stripUndefinedDeep(v);
    });
    return out as T;
  }
  return value;
}
