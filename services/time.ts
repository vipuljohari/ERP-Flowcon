/**
 * Client system clocks are not trustworthy — a misconfigured PC or a dead
 * CMOS battery can silently make `new Date()` return a date that's wrong by
 * months or years, with no error anywhere. This app used to trust
 * `new Date()` directly for every "right now" dispatch/inward timestamp;
 * one bad clock produced an entry dated in a future year that then sorted
 * as "most recent" everywhere in the app (the Dashboard's Global Dispatch
 * Feed), permanently, until caught by hand.
 *
 * The fix here needs no server round-trip, new Firestore collection, or
 * security-rule change (all extra deploy steps this project can't easily
 * verify) — it uses a value already trustworthy for free: BUILD_TIME below
 * is baked into the bundle by Vite's `define` (see vite.config.ts) at the
 * moment this code was actually built, using the BUILD machine's clock —
 * never the end user's. A viewer's system clock can never legitimately be
 * showing a date meaningfully before this bundle existed, or wildly past
 * it, so that's the sanity check applied to every "now" this app saves.
 */
const BUILD_TIME_MS = Date.parse((process.env as any).BUILD_TIME || '') || 0;

// Generous on both sides — this only needs to catch a clock that's wrong by
// months/years (the actual failure mode seen in production), never flag an
// ordinary few-minutes/hours clock skew or a stretch between deploys.
const MAX_PAST_DRIFT_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months before build
const MAX_FUTURE_DRIFT_MS = 3 * 24 * 60 * 60 * 1000; // ~3 days after build

// Best-effort corrected "now": the local clock, unless it's implausible
// relative to when this exact code was built, in which case falls back to
// the (trustworthy) build time itself. Not a source of truth, but always
// far closer to reality than a broken clock left uncorrected — and,
// crucially, it stops advancing arbitrarily into the future, so a bad
// clock can no longer produce an entry that permanently sorts as "newest".
export function correctedNow(): Date {
  const now = Date.now();
  if (BUILD_TIME_MS > 0 && (now < BUILD_TIME_MS - MAX_PAST_DRIFT_MS || now > BUILD_TIME_MS + MAX_FUTURE_DRIFT_MS)) {
    return new Date(BUILD_TIME_MS);
  }
  return new Date(now);
}

// Local (not UTC) ISO-ish timestamp string, clock-corrected by default.
// Every existing call site across the app calls this with no argument for
// "timestamp this as right now" — moving the correction into the default
// parameter here means none of those call sites needed to change.
export const getLocalISOString = (date: Date = correctedNow()): string => {
  const pad = (num: number) => String(num).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${y}-${m}-${d}T${h}:${min}:${s}.${ms}`;
};

// Y-M-D string for "today", clock-corrected — used to bound date-picker
// inputs (Inventory's Entry Date field) so a bad local clock can't silently
// let a wrong-dated entry through validation that itself trusted that same
// clock.
export const getLocalDateStr = (date: Date = correctedNow()): string => {
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
