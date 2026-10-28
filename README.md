# PackingHelper AI Worker

Cloudflare Worker that fronts the Anthropic API for the PackingHelper iOS app's
AI packing assistant. It:

1. Verifies the caller is a paying subscriber (RevenueCat REST, entitlement `plus`).
2. Enforces a soft usage cap (50 assistant messages / calendar month per RevenueCat app-user ID) in KV.
3. Calls Claude (`claude-haiku-4-5`) with structured outputs and returns advice + suggested items.
4. Proxies Unsplash photo search for trip cover photos (first page free, further pages Plus only), caching results in KV.

The Anthropic API key never leaves the Worker. The iOS app only knows this
Worker's URL.

## HTTP contract

Keep this in sync with the Swift DTOs in
`PackingHelper/Services/AIAssistantService.swift`.

### `POST /v1/assistant/message`

Request (trip mode):

```json
{
  "rcAppUserId": "$RCAnonymousID:abc123",
  "mode": "trip",
  "tripContext": {
    "tripName": "Lisbon Getaway",
    "destinationName": "Lisbon, Portugal",
    "destinationLatitude": 38.72,
    "originName": "Boston, MA",
    "startDate": "2026-08-10",
    "endDate": "2026-08-15",
    "durationDays": 5,
    "tripType": "plane",
    "accommodation": "hotel",
    "packerCount": 2,
    "listNames": ["Default", "Beach"],
    "existingItems": ["Passport", "Swimsuit", "Laptop"],
    "otherPackersItems": ["Sunscreen"],
    "pastTrips": [
      {
        "name": "Maui",
        "destinationName": "Maui, HI",
        "month": "2025-07",
        "durationDays": 7,
        "tripType": "plane",
        "accommodation": "rental",
        "lists": [
          { "name": "Snacks", "kind": "packing", "items": ["Trail mix", "Dried mango"] },
          { "name": "Beach", "kind": "packing", "fromTemplate": "Beach", "items": ["Snorkel"] }
        ]
      }
    ],
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

`mode` defaults to `"trip"` when omitted (older clients). `existingItems` is the
asking packer's items plus unassigned ones, packed or not; `otherPackersItems`,
`pastTrips`, `tripName`, `destinationLatitude`, `originName`, and `listNames` are
optional. `pastTrips` is the packer's most similar other trips first (at most 6,
80 items each), leaving out items already on the current trip; a list without
`fromTemplate` was made on that trip. Template mode sends `pastTrips` too, with
trips the template was applied to first.

Request (template mode), for building a reusable template list with no trip:

```json
{
  "rcAppUserId": "$RCAnonymousID:abc123",
  "mode": "template",
  "templateContext": {
    "name": "Beach Weekend",
    "listKind": "packing",
    "isDayOf": false,
    "countAsDays": false,
    "existingItems": ["Swimsuit"],
    "pastTrips": []
  },
  "messages": [
    { "role": "user", "content": "Suggest a starting set for Beach Weekend" }
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
    { "name": "Trail mix", "category": "other", "count": 1, "kind": "packing", "fromTrip": "Maui" },
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

### `POST /v1/photos/search`

Keep in sync with `PackingHelper/Services/UnsplashService.swift`.

Request:

```json
{ "rcAppUserId": "$RCAnonymousID:abc123", "query": "Lisbon", "page": 1 }
```

`query` is trimmed, 1–100 chars. `page` is 1–50 (defaults to 1). Results are
25 per page, `orientation=landscape`, `content_filter=high`, and cached in KV
for 24h under `unsplash:search:v2:{normalizedQuery}:{page}` (lowercased,
whitespace collapsed). Page 1 needs no subscription (the app shows free users
one page for their destination); `page` > 1 requires the `plus` entitlement.

Success `200`:

```json
{
  "page": 1,
  "totalPages": 34,
  "results": [
    {
      "id": "abc123",
      "width": 6000,
      "height": 4000,
      "color": "#a3b1c2",
      "blurHash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
      "urls": { "raw": "https://images.unsplash.com/...", "small": "https://images.unsplash.com/..." },
      "htmlLink": "https://unsplash.com/photos/abc123",
      "downloadLocation": "https://api.unsplash.com/photos/abc123/download?ixid=...",
      "photographer": { "name": "Jane Doe", "username": "janedoe", "profileURL": "https://unsplash.com/@janedoe" }
    }
  ]
}
```

`color` and `blurHash` may be `null`.

### `POST /v1/photos/random`

One random photo for a query, used to give new trips a default cover photo.
Not subscription-gated and not cached (each call spends Unsplash quota).

Request:

```json
{ "rcAppUserId": "$RCAnonymousID:abc123", "query": "Lisbon" }
```

`query` is trimmed, 1–100 chars. Uses `orientation=landscape`,
`content_filter=high`.

Success `200`: a single photo object, same shape as one entry of the search
`results` above. `404 no_results` when nothing matches (the app then retries
with the trip name).

### `POST /v1/photos/download`

Fires Unsplash's download-tracking endpoint, which the API guidelines require
whenever a user selects a photo. The app calls it when the trip is saved.

Request:

```json
{ "rcAppUserId": "$RCAnonymousID:abc123", "downloadLocation": "https://api.unsplash.com/photos/abc123/download?ixid=..." }
```

`downloadLocation` must be `https://api.unsplash.com/photos/{id}/download`
(anything else is a `400`, so the route can't proxy arbitrary URLs).
Not subscription-gated, since free users can pick photos from the first page.

Success `204` (no body).

Photo route errors use the same shape as above:

| Status | code             | Meaning                                         |
| ------ | ---------------- | ----------------------------------------------- |
| 400    | `bad_request`    | Missing/invalid body, query, or downloadLocation |
| 401    | `not_subscribed` | Search `page` > 1 without an active `plus` entitlement |
| 404    | `no_results`     | Random: no photo matched the query              |
| 429    | `rate_limited`   | Unsplash hourly quota exhausted                 |
| 502    | `upstream_error` | Other Unsplash failure                          |

## Setup

```sh
npm install
wrangler login

# 1. Create the KV namespace, paste the returned id into wrangler.toml.
wrangler kv namespace create USAGE_KV

# 2. Secrets.
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put REVENUECAT_SECRET_KEY   # RevenueCat *secret* key (sk_...)
wrangler secret put UNSPLASH_ACCESS_KEY     # Unsplash app *Access Key* (not the Secret Key)
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
- Unsplash's quota is per app, not per user (50 req/hr on a demo app, 5,000 after production approval), so search results are cached in KV for 24h. Images themselves are hotlinked from `images.unsplash.com` by the app, as the guidelines require, and don't count against the quota.
