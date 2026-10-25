// Daily allowance for scans that use the server's own (shared) Gemini key.
// People who add their own key aren't counted. Limits are off unless set, so a
// personal install on your own PC is unlimited; render.yaml turns them on for the public site.
const PER_USER = Number(process.env.SHARED_DAILY_PER_USER) || Infinity;
const TOTAL = Number(process.env.SHARED_DAILY_TOTAL) || Infinity;

const today = () => new Date().toISOString().slice(0, 10); // resets at midnight UTC
let day = today();
let total = 0;
const used = new Map(); // who -> scans today

function roll() {
  if (today() !== day) {
    day = today();
    total = 0;
    used.clear();
  }
}

/** Scans this person can still make on the shared key today (Infinity when unlimited). */
export function sharedRemaining(who) {
  roll();
  return Math.max(0, Math.min(PER_USER - (used.get(who) || 0), TOTAL - total));
}

/** Reserves one shared scan. Returns null on success, or "user" / "total" naming the limit that's used up. */
export function takeShared(who) {
  roll();
  if ((used.get(who) || 0) >= PER_USER) return "user";
  if (total >= TOTAL) return "total";
  used.set(who, (used.get(who) || 0) + 1);
  total++;
  return null;
}

/** Gives a reserved scan back, e.g. when Google was too busy to read the photo. */
export function refundShared(who) {
  if (used.get(who) > 0) {
    used.set(who, used.get(who) - 1);
    total--;
  }
}

export const sharedLimits = { perUser: PER_USER, total: TOTAL };
