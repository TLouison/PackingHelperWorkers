import type { Env } from "./types";

// Positive-verification cache TTL (seconds). We never cache negatives.
const ENT_CACHE_TTL = 600;

interface RCActiveEntitlement {
  entitlement_id: string;
  expires_at: number | null; // ms since epoch; null = lifetime
}

interface RCActiveEntitlementsResponse {
  items?: RCActiveEntitlement[];
}

/** RevenueCat itself failed (outage, bad key), as opposed to "not subscribed". */
export class RevenueCatError extends Error {}

/**
 * Returns true if the RevenueCat customer has the configured entitlement
 * active. Uses a short-lived KV cache to skip the REST round-trip on repeated
 * messages from the same user. Throws `RevenueCatError` when RevenueCat can't
 * answer, so callers don't report an outage as a lapsed subscription.
 *
 * Uses the v2 active-entitlements endpoint: v1 `/subscribers` reports only one
 * product per entitlement and can miss an active App Store purchase when the
 * customer also has (expired) Test Store purchases. An unknown customer is a
 * 404, which means not subscribed. Sandbox purchases are included, so
 * simulator testing works.
 */
export async function verifySubscriber(
  env: Env,
  rcAppUserId: string,
): Promise<boolean> {
  const cacheKey = `ent:${rcAppUserId}`;
  const cached = await env.USAGE_KV.get(cacheKey);
  if (cached === "1") return true;

  let res: Response;
  try {
    res = await fetch(
      `https://api.revenuecat.com/v2/projects/${encodeURIComponent(env.RC_PROJECT_ID)}` +
        `/customers/${encodeURIComponent(rcAppUserId)}/active_entitlements`,
      {
        headers: {
          Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (e) {
    throw new RevenueCatError(e instanceof Error ? e.message : String(e));
  }

  if (res.status === 404) return false;
  if (!res.ok) {
    const detail = await res.text();
    console.log("verifySubscriber: RC HTTP", res.status, "for", rcAppUserId, detail);
    throw new RevenueCatError(`RevenueCat HTTP ${res.status}`);
  }

  const body = (await res.json()) as RCActiveEntitlementsResponse;
  const ent = body.items?.find((item) => item.entitlement_id === env.ENTITLEMENT_ID);
  // The endpoint lists only active entitlements; the expiry check guards against lag
  const active = !!ent && (ent.expires_at === null || ent.expires_at > Date.now());

  if (!active) {
    console.log("verifySubscriber: no active", env.ENTITLEMENT_ID, "for", rcAppUserId);
  }
  if (active) {
    // Cache only the positive result.
    await env.USAGE_KV.put(cacheKey, "1", { expirationTtl: ENT_CACHE_TTL });
  }
  return active;
}
