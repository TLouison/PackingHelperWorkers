import type { Env, AssistantRequest, ModelOutput } from "./types";
import { buildPrompt, SUGGESTION_SCHEMA } from "./prompt";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Distinguishes a retryable upstream (429/529) from a hard failure so the
// handler can return 503 vs 502.
export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

interface AnthropicMessagesResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

const CACHE = { type: "ephemeral" } as const;

/**
 * Cache breakpoints, from most to least shared: the mode's instructions (identical for every
 * user), the trip/template context (fixed for a chat session), and the latest user turn (so
 * the next send reads the whole history from cache). The lists' current state goes last, as a
 * mid-conversation system message, because it changes whenever they add an item.
 */
function buildRequestParts(req: AssistantRequest) {
  const prompt = buildPrompt(req);
  const system = [
    { type: "text", text: prompt.instructions, cache_control: CACHE },
    { type: "text", text: prompt.context, cache_control: CACHE },
  ];
  const last = req.messages.length - 1;
  const messages: unknown[] = req.messages.map((m, i) =>
    i === last
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: CACHE }] }
      : m,
  );
  messages.push({ role: "system", content: prompt.currentState });
  return { system, messages };
}

/**
 * Calls the Anthropic Messages API (raw fetch — no SDK, so the Worker has no
 * runtime deps and no SDK-version coupling) with structured outputs, and
 * returns the parsed, schema-valid model output.
 */
export async function callAnthropic(env: Env, req: AssistantRequest): Promise<ModelOutput> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL, // from wrangler.toml [vars]
      max_tokens: 2048,
      ...buildRequestParts(req),
      output_config: {
        format: { type: "json_schema", schema: SUGGESTION_SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const retryable = res.status === 429 || res.status === 529;
    const detail = await res.text().catch(() => "");
    throw new AnthropicError(
      `anthropic ${res.status}: ${detail.slice(0, 300)}`,
      retryable,
    );
  }

  const body = (await res.json()) as AnthropicMessagesResponse;
  // Token usage per call, for tuning cost (cache reads should dominate after the first send)
  const u = body.usage;
  if (u) {
    console.log(
      `usage mode=${req.mode} in=${u.input_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} cacheWrite=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens ?? 0}`,
    );
  }
  const text = body.content.find((b) => b.type === "text")?.text ?? "{}";

  // Structured outputs guarantee schema-valid JSON in the text block.
  const parsed = JSON.parse(text) as ModelOutput;
  return {
    message: typeof parsed.message === "string" ? parsed.message : "",
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}
