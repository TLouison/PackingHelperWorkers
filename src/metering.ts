import type { Env } from "./types";

// Keep spent counts around ~62 days so a fresh month always starts clean.
const USAGE_TTL = 62 * 24 * 60 * 60;

function monthKey(rcAppUserId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `usage:${rcAppUserId}:${y}-${m}`;
}

/** First instant of next UTC month — when the cap resets. */
export function nextResetISO(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
}

export interface UsageState {
  count: number;
  cap: number;
  remaining: number;
  atCap: boolean;
}

export async function getUsage(env: Env, rcAppUserId: string): Promise<UsageState> {
  const cap = Number(env.MONTHLY_CAP);
  const raw = await env.USAGE_KV.get(monthKey(rcAppUserId, new Date()));
  const count = raw ? Number(raw) : 0;
  const remaining = Math.max(0, cap - count);
  return { count, cap, remaining, atCap: count >= cap };
}

/**
 * Increment this month's count and return the new remaining.
 * Called only after a successful model call.
 *
 * KV is eventually consistent, so tightly concurrent requests can overshoot
 * the cap slightly. This is a soft product cap, not billing enforcement —
 * acceptable.
 */
export async function recordUsage(env: Env, rcAppUserId: string): Promise<number> {
  const key = monthKey(rcAppUserId, new Date());
  const raw = await env.USAGE_KV.get(key);
  const next = (raw ? Number(raw) : 0) + 1;
  await env.USAGE_KV.put(key, String(next), { expirationTtl: USAGE_TTL });
  return Math.max(0, Number(env.MONTHLY_CAP) - next);
}
