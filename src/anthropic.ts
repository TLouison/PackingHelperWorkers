import type { Env, ChatMessage, ModelOutput, TripContext } from "./types";
import { buildSystemPrompt, SUGGESTION_SCHEMA } from "./prompt";

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
}

/**
 * Calls the Anthropic Messages API (raw fetch — no SDK, so the Worker has no
 * runtime deps and no SDK-version coupling) with structured outputs, and
 * returns the parsed, schema-valid model output.
 */
export async function callAnthropic(
  env: Env,
  tripContext: TripContext,
  messages: ChatMessage[],
): Promise<ModelOutput> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL, // "claude-haiku-4-5" — no thinking/effort params (unsupported)
      max_tokens: 2048,
      system: buildSystemPrompt(tripContext),
      messages,
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
  const text = body.content.find((b) => b.type === "text")?.text ?? "{}";

  // Structured outputs guarantee schema-valid JSON in the text block.
  const parsed = JSON.parse(text) as ModelOutput;
  return {
    message: typeof parsed.message === "string" ? parsed.message : "",
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}
