import type {
  Env,
  AssistantRequest,
  ChatMessage,
  TemplateContext,
  TripContext,
  PhotoSearchRequest,
  PhotoRandomRequest,
  PhotoDownloadRequest,
} from "./types";
import { verifySubscriber } from "./revenuecat";
import { getUsage, recordUsage, nextResetISO } from "./metering";
import { callAnthropic, AnthropicError } from "./anthropic";
import {
  searchPhotos,
  randomPhoto,
  trackDownload,
  isValidDownloadLocation,
  UnsplashError,
} from "./unsplash";

const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;
const MAX_QUERY_CHARS = 100;
const MAX_PHOTO_PAGE = 50;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: code, message, ...extra }, status);
}

function validate(body: unknown): AssistantRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.rcAppUserId !== "string" || b.rcAppUserId.length === 0) return null;
  // Older clients send no mode: trip.
  const mode = b.mode ?? "trip";
  if (mode !== "trip" && mode !== "template") return null;
  const contextKey = mode === "trip" ? "tripContext" : "templateContext";
  if (typeof b[contextKey] !== "object" || b[contextKey] === null) return null;
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null;

  const messages: ChatMessage[] = [];
  for (const m of b.messages) {
    if (typeof m !== "object" || m === null) return null;
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant") return null;
    if (typeof mm.content !== "string" || mm.content.length === 0) return null;
    messages.push({ role: mm.role, content: mm.content.slice(0, MAX_CONTENT_CHARS) });
  }
  if (messages.length > MAX_MESSAGES) return null;

  if (mode === "template") {
    const t = b.templateContext as Record<string, unknown>;
    if (typeof t.name !== "string" || !Array.isArray(t.existingItems)) return null;
    return {
      rcAppUserId: b.rcAppUserId,
      mode: "template",
      templateContext: b.templateContext as TemplateContext,
      messages,
    };
  }
  const t = b.tripContext as Record<string, unknown>;
  if (!Array.isArray(t.existingItems)) return null;
  return {
    rcAppUserId: b.rcAppUserId,
    mode: "trip",
    tripContext: b.tripContext as TripContext,
    messages,
  };
}

function validatePhotoSearch(body: unknown): PhotoSearchRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.rcAppUserId !== "string" || b.rcAppUserId.length === 0) return null;
  if (typeof b.query !== "string") return null;
  const query = b.query.trim();
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) return null;
  const page = b.page === undefined ? 1 : b.page;
  if (typeof page !== "number" || !Number.isInteger(page)) return null;
  if (page < 1 || page > MAX_PHOTO_PAGE) return null;
  return { rcAppUserId: b.rcAppUserId, query, page };
}

function validatePhotoRandom(body: unknown): PhotoRandomRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.rcAppUserId !== "string" || b.rcAppUserId.length === 0) return null;
  if (typeof b.query !== "string") return null;
  const query = b.query.trim();
  if (query.length === 0 || query.length > MAX_QUERY_CHARS) return null;
  return { rcAppUserId: b.rcAppUserId, query };
}

function validatePhotoDownload(body: unknown): PhotoDownloadRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.rcAppUserId !== "string" || b.rcAppUserId.length === 0) return null;
  if (typeof b.downloadLocation !== "string") return null;
  if (!isValidDownloadLocation(b.downloadLocation)) return null;
  return { rcAppUserId: b.rcAppUserId, downloadLocation: b.downloadLocation };
}

async function readJSON(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function unsplashErrorResponse(e: unknown): Response {
  if (e instanceof UnsplashError && e.rateLimited) {
    return errorResponse(429, "rate_limited", "Too many photo searches — try again shortly.");
  }
  console.error("Unsplash call failed:", e instanceof Error ? e.message : e);
  return errorResponse(502, "upstream_error", "Photo search failed.");
}

async function handleAssistantMessage(request: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "bad_request", "Body must be valid JSON.");
  }

  const req = validate(raw);
  if (!req) {
    return errorResponse(400, "bad_request", "Missing or invalid fields.");
  }

  // 1. Subscription gate.
  const subscribed = await verifySubscriber(env, req.rcAppUserId);
  if (!subscribed) {
    return errorResponse(401, "not_subscribed", "An active subscription is required.");
  }

  // 2. Usage cap.
  const usage = await getUsage(env, req.rcAppUserId);
  if (usage.atCap) {
    return errorResponse(429, "limit_reached", "Monthly message limit reached.", {
      remaining: 0,
      resetsAt: nextResetISO(new Date()),
    });
  }

  // 3. Model call.
  let output;
  try {
    output = await callAnthropic(env, req);
  } catch (e) {
    console.error("callAnthropic failed:", e instanceof Error ? e.message : e);
    if (e instanceof AnthropicError && e.retryable) {
      return errorResponse(503, "upstream_busy", "The assistant is busy — try again shortly.");
    }
    return errorResponse(502, "upstream_error", "The assistant failed to respond.");
  }

  // 4. Meter (only successful calls count) and respond.
  const remaining = await recordUsage(env, req.rcAppUserId);
  return json(
    { message: output.message, items: output.items, remaining },
    200,
    { "X-Messages-Remaining": String(remaining) },
  );
}

async function handlePhotoSearch(request: Request, env: Env): Promise<Response> {
  const raw = await readJSON(request);
  if (raw === undefined) {
    return errorResponse(400, "bad_request", "Body must be valid JSON.");
  }
  const req = validatePhotoSearch(raw);
  if (!req) {
    return errorResponse(400, "bad_request", "Missing or invalid fields.");
  }

  // The first page is free for everyone; loading more needs Plus.
  if (req.page > 1 && !(await verifySubscriber(env, req.rcAppUserId))) {
    return errorResponse(401, "not_subscribed", "An active subscription is required.");
  }

  try {
    return json(await searchPhotos(env, req.query, req.page));
  } catch (e) {
    return unsplashErrorResponse(e);
  }
}

async function handlePhotoRandom(request: Request, env: Env): Promise<Response> {
  const raw = await readJSON(request);
  if (raw === undefined) {
    return errorResponse(400, "bad_request", "Body must be valid JSON.");
  }
  const req = validatePhotoRandom(raw);
  if (!req) {
    return errorResponse(400, "bad_request", "Missing or invalid fields.");
  }

  // Not gated: new trips get a random cover photo for everyone.
  try {
    const photo = await randomPhoto(env, req.query);
    if (!photo) {
      return errorResponse(404, "no_results", "No photos matched that search.");
    }
    return json(photo);
  } catch (e) {
    return unsplashErrorResponse(e);
  }
}

async function handlePhotoDownload(request: Request, env: Env): Promise<Response> {
  const raw = await readJSON(request);
  if (raw === undefined) {
    return errorResponse(400, "bad_request", "Body must be valid JSON.");
  }
  const req = validatePhotoDownload(raw);
  if (!req) {
    return errorResponse(400, "bad_request", "Missing or invalid fields.");
  }

  // Not gated: free users pick photos from the first page, and Unsplash
  // requires the download ping for every pick.
  try {
    await trackDownload(env, req.downloadLocation);
    return new Response(null, { status: 204 });
  } catch (e) {
    return unsplashErrorResponse(e);
  }
}

const routes: Record<string, (request: Request, env: Env) => Promise<Response>> = {
  "/v1/assistant/message": handleAssistantMessage,
  "/v1/photos/search": handlePhotoSearch,
  "/v1/photos/random": handlePhotoRandom,
  "/v1/photos/download": handlePhotoDownload,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const handler = routes[url.pathname];
    if (request.method !== "POST" || !handler) {
      return errorResponse(404, "not_found", "Unknown route.");
    }
    return handler(request, env);
  },
} satisfies ExportedHandler<Env>;
