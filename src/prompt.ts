import type { TripContext } from "./types";

// Cap the existing-items list so a huge trip can't blow up the prompt.
const MAX_EXISTING_ITEMS = 200;

const INSTRUCTIONS = `You are an expert travel packing assistant embedded in a trip-packing app. You help the user decide what to pack and what to do before a trip, grounded in the trip details provided.

Respond with a short, practical, friendly "message" plus a list of concrete suggested "items".

Rules for items:
- Assign each item a "category" that is EXACTLY one of: Clothing, Electronics, Toiletries, Task, other.
- "kind" is "task" for things to DO before/at the trip (book transport, print documents, charge devices, refill prescriptions), otherwise "packing".
- Scale "count" sensibly to trip duration and number of packers. Use 1 for shared/single items.
- Suggest smart accessories the user is likely to forget: if they mention or already have an item, propose the companion piece (laptop -> charger; swimsuit -> coverup; camera -> spare battery; hiking boots -> wool socks). When an item is an accessory for something, set "accessoryFor" to that thing's name.
- NEVER suggest an item the user already has (see "Already on their lists"). Instead, reason about gaps and accessories for those items.
- Use the weather when provided; when weather is unavailable, infer likely climate from destination and dates and advise generally.
- Keep "message" brief (1-3 sentences). For pure advice with nothing to add, return an empty "items" array.`;

function weatherBlock(ctx: TripContext): string {
  if (!ctx.weather) {
    return "Weather: unavailable (trip is outside the forecast window) — advise from destination and season.";
  }
  const days = ctx.weather.daily
    .map((d) => `  ${d.day}: ${d.lowC}–${d.highC}°C, ${d.condition}`)
    .join("\n");
  return `Weather (current ${ctx.weather.currentTempC}°C):\n${days}`;
}

export function buildSystemPrompt(ctx: TripContext): string {
  const existing = ctx.existingItems.slice(0, MAX_EXISTING_ITEMS);
  const existingBlock =
    existing.length > 0 ? existing.join(", ") : "(nothing packed yet)";

  return `${INSTRUCTIONS}

--- TRIP ---
Destination: ${ctx.destinationName || "unspecified"}
Dates: ${ctx.startDate} to ${ctx.endDate} (${ctx.durationDays} day(s))
Travel by: ${ctx.tripType}
Staying in: ${ctx.accommodation}
Number of packers: ${ctx.packerCount}
${weatherBlock(ctx)}

Already on their lists (do NOT re-suggest these): ${existingBlock}`;
}

// Structured-output schema. Constraints kept within what structured outputs
// support: additionalProperties:false everywhere, enums, no min/max.
// accessoryFor is optional (omitted from "required").
export const SUGGESTION_SCHEMA = {
  type: "object",
  properties: {
    message: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: {
            type: "string",
            enum: ["Clothing", "Electronics", "Toiletries", "Task", "other"],
          },
          count: { type: "integer" },
          kind: { type: "string", enum: ["packing", "task"] },
          accessoryFor: { type: "string" },
        },
        required: ["name", "category", "count", "kind"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "items"],
  additionalProperties: false,
} as const;
