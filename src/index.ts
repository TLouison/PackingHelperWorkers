import type { Env, AssistantRequest, ChatMessage } from "./types";
import { verifySubscriber } from "./revenuecat";
import { getUsage, recordUsage, nextResetISO } from "./metering";
import { callAnthropic, AnthropicError } from "./anthropic";

const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;

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
  if (typeof b.tripContext !== "object" || b.tripContext === null) return null;
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

  return {
    rcAppUserId: b.rcAppUserId,
    tripContext: b.tripContext as AssistantRequest["tripContext"],
    messages,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/assistant/message") {
      return errorResponse(404, "not_found", "Unknown route.");
    }

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
      output = await callAnthropic(env, req.tripContext, req.messages);
    } catch (e) {
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
  },
} satisfies ExportedHandler<Env>;
