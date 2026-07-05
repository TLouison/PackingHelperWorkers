import type { Env } from "./types";

// Positive-verification cache TTL (seconds). We never cache negatives.
const ENT_CACHE_TTL = 600;

interface RCEntitlement {
  expires_date: string | null; // null = lifetime
}

interface RCResponse {
  subscriber?: {
    entitlements?: Record<string, RCEntitlement>;
  };
}

/**
 * Returns true if the RevenueCat subscriber has the configured entitlement
 * active. Uses a short-lived KV cache to skip the REST round-trip on repeated
 * messages from the same user.
 *
 * Note: the RevenueCat REST endpoint *creates* an unknown subscriber on GET —
 * that's harmless, it just returns empty entitlements (→ not subscribed).
 * Sandbox purchases are reported here too, so simulator testing works.
 */
export async function verifySubscriber(
  env: Env,
  rcAppUserId: string,
): Promise<boolean> {
  const cacheKey = `ent:${rcAppUserId}`;
  const cached = await env.USAGE_KV.get(cacheKey);
  if (cached === "1") return true;

  const res = await fetch(
    `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(rcAppUserId)}`,
    {
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!res.ok) {
    // Treat RC outages as "not verified" rather than granting access.
    console.log("verifySubscriber: RC HTTP", res.status, "for", rcAppUserId);
    return false;
  }

  const body = (await res.json()) as RCResponse;
  // TEMP DIAGNOSTIC — remove once verified. Shows the exact entitlement keys RC
  // returns vs the ENTITLEMENT_ID we look for.
  console.log(
    "verifySubscriber:",
    rcAppUserId,
    "looking for",
    env.ENTITLEMENT_ID,
    "found keys",
    JSON.stringify(Object.keys(body.subscriber?.entitlements ?? {})),
  );
  const ent = body.subscriber?.entitlements?.[env.ENTITLEMENT_ID];
  if (!ent) return false;

  const active =
    ent.expires_date === null || new Date(ent.expires_date).getTime() > Date.now();

  if (active) {
    // Cache only the positive result.
    await env.USAGE_KV.put(cacheKey, "1", { expirationTtl: ENT_CACHE_TTL });
  }
  return active;
}
