# PackingHelper AI Worker

Cloudflare Worker that fronts the Anthropic API for the PackingHelper iOS app's
AI packing assistant. It:

1. Verifies the caller is a paying subscriber (RevenueCat REST, entitlement `plus`).
2. Enforces a soft usage cap (50 assistant messages / calendar month per RevenueCat app-user ID) in KV.
3. Calls Claude (`claude-haiku-4-5`) with structured outputs and returns advice + suggested items.

The Anthropic API key never leaves the Worker. The iOS app only knows this
Worker's URL.

## HTTP contract

Keep this in sync with the Swift DTOs in
`PackingHelper/Services/AIAssistantService.swift`.

### `POST /v1/assistant/message`

Request:

```json
{
  "rcAppUserId": "$RCAnonymousID:abc123",
  "tripContext": {
    "destinationName": "Lisbon, Portugal",
    "startDate": "2026-08-10",
    "endDate": "2026-08-15",
    "durationDays": 5,
    "tripType": "plane",
    "accommodation": "hotel",
    "packerCount": 2,
    "existingItems": ["Passport", "Swimsuit", "Laptop"],
    "weather": {
      "currentTempC": 26,
      "daily": [
        { "day": "2026-08-10", "highC": 30, "lowC": 19, "condition": "Sunny" }
      ]
    }
  },
  "messages": [
    { "role": "user", "content": "We're doing a beach day and one nice dinner." }
  ]
}
```

`tripContext.weather` is optional — omitted when the trip is outside the 5-day
forecast window.

Success `200`:

```json
{
  "message": "For a Lisbon beach trip you're in good shape...",
  "items": [
    { "name": "Swimsuit coverup", "category": "Clothing", "count": 2, "kind": "packing", "accessoryFor": "Swimsuit" },
    { "name": "Laptop charger", "category": "Electronics", "count": 1, "kind": "packing", "accessoryFor": "Laptop" },
    { "name": "Reserve dinner spot", "category": "Task", "count": 1, "kind": "task" }
  ],
  "remaining": 42
}
```

Also sets header `X-Messages-Remaining` (body is authoritative).

Errors (`{ "error": <code>, "message": <human> }`):

| Status | code             | Meaning                                            |
| ------ | ---------------- | -------------------------------------------------- |
| 400    | `bad_request`    | Missing/invalid body                               |
| 401    | `not_subscribed` | No active `plus` entitlement                       |
| 429    | `limit_reached`  | Monthly cap hit (adds `remaining: 0`, `resetsAt`)  |
| 502    | `upstream_error` | Anthropic call failed                              |
| 503    | `upstream_busy`  | Anthropic overloaded/rate-limited (retryable)      |

## Setup

```sh
npm install
wrangler login

# 1. Create the KV namespace, paste the returned id into wrangler.toml.
wrangler kv namespace create USAGE_KV

# 2. Secrets.
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put REVENUECAT_SECRET_KEY   # RevenueCat *secret* key (sk_...)
```

### RevenueCat dashboard (one-time)

- Create an **entitlement** with identifier `plus`.
- Attach the products `FY2X7BQ9` (annual) and `4HT3JM8D` (monthly) to it.
- Ensure App Store Connect is linked so observer-mode StoreKit transactions sync.
- Copy the **secret** API key (`sk_…`) → `wrangler secret put REVENUECAT_SECRET_KEY`.
  The iOS app keeps using the **public** SDK key.

## Local dev

```sh
cp .dev.vars.example .dev.vars   # fill in real secrets; set MONTHLY_CAP="2" to test the cap
npm run dev                       # http://localhost:8787

curl -s http://localhost:8787/v1/assistant/message \
  -H 'content-type: application/json' \
  -d @sample.json | jq
```

An unknown `rcAppUserId` returns `401 not_subscribed`. Use a real sandbox-
subscribed RevenueCat app-user ID (log `Purchases.shared.appUserID` from the app)
to get a `200`.

Point the app at local dev via the Developer Menu (`debug_workerURLOverride` =
`http://localhost:8787`).

## Deploy

```sh
npm run typecheck
wrangler deploy
```

Copy the deployed `*.workers.dev` URL into `Config.xcconfig` → `WORKER_URL` in
the iOS repo.

## Design notes

- Raw `fetch` to the Anthropic API (no SDK) → zero runtime deps, no SDK-version coupling on Workers.
- Metering key is `usage:{rcAppUserId}:{YYYY-MM}` (UTC). The month in the key *is* the reset — no cron. Keys self-expire after ~62 days.
- KV is eventually consistent, so the cap is soft (concurrent requests can overshoot slightly). Fine for a product cap, not billing.
- Model ID lives in `wrangler.toml [vars]` — the future per-user "intelligence add-on" resolves the model before `callAnthropic`.
