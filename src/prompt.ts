import type { AssistantRequest, TemplateContext, TripContext } from "./types";

// Cap the item lists so a huge trip can't blow up the prompt.
const MAX_EXISTING_ITEMS = 200;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ITEM_RULES = `Rules for items:
- Assign each item a "category" that is EXACTLY one of: Clothing, Electronics, Toiletries, Task, other.
- "kind" is "task" for things to DO (book transport, print documents, charge devices, refill prescriptions), otherwise "packing". Task items use category "Task".
- Use short, plain item names the way someone would write them on a list ("Phone charger", not "A reliable phone charging cable").
- NEVER suggest anything already on their list. Treat plurals, brand names, and close synonyms as the same item ("Phone charger" = "iPhone charger" = "Charging cable"; "Toothbrush" covers "Electric toothbrush"). If in doubt, leave it out.
- Only suggest items you are highly confident this person will actually use. A short list of sure things beats a long list of maybes; usually 3-10 items, fewer is fine, and an empty list is fine when they're covered.
- Companions: look at what's already on their list and fill obvious gaps, the piece that item needs to be useful (toothbrush -> toothpaste; laptop -> laptop charger; camera -> spare battery or memory card; contact lenses -> lens solution and case; swimsuit -> sunscreen). Set "accessoryFor" to the existing item's name. Skip the companion if anything on the list already covers it.
- Keep "message" brief (1-3 sentences), friendly, and specific to them. For pure advice with nothing to add, return an empty "items" array.`;

const TRIP_INSTRUCTIONS = `You are an expert travel packing assistant embedded in a trip-packing app. You help the user decide what to pack and what to do before a trip, grounded in the trip details below.

Respond with a short, practical "message" plus a list of concrete suggested "items".

Use every trip detail:
- Destination and time of year: infer the likely climate and season (hemisphere matters; tropical places have wet and dry seasons). Use the forecast when provided.
- How they travel: flying means carry-on limits and liquids rules (travel-size toiletries, a neck pillow for long flights, chargers in the carry-on); driving allows bulkier items and car needs (snacks, phone mount, car charger); trains, boats, and ferries sit in between (motion sickness remedies on boats and ferries).
- Where they stay: hotels provide towels, shampoo, and hair dryers, so don't suggest those unless asked; rentals often lack basics (dish soap, laundry detergent, coffee filters); staying with family or friends suggests a host gift and slippers.
- The trip name and list names hint at the purpose (a wedding, a ski trip, a conference); plan for it.
- Scale "count" to trip duration (clothing) and number of packers. Use 1 for shared/single items.
- Other packers on the trip: shared items they're already bringing (sunscreen, adapters, first aid) are covered; personal items (toothbrush, clothes) are not.

${ITEM_RULES}`;

const TEMPLATE_INSTRUCTIONS = `You are an expert travel packing assistant embedded in a trip-packing app. The user is building a reusable template list that they will apply to many future trips. There is no specific trip: no dates, destination, or weather.

Help them get a strong starting point:
- Work out what the list is for from its name and the conversation (e.g. "Beach", "Business Trip", "Toiletries", "Before I Leave"). If the name is too vague to know, suggest a short universal core and ask one short question in "message" about what kind of trips it's for.
- Suggest the essentials someone reliably needs for that kind of trip, not destination-specific extras. A template should hold what's packed every time.
- Group naturally: cover the main areas the list is for, but don't pad it. Usually 8-15 items for a first pass on an empty list, fewer when filling gaps.
- Use counts for one typical trip of this kind (often 1). If counts are set from trip length, use 1 for everything.
- Match the list kind: a tasks list gets only tasks ("kind": "task"), a packing list gets only things to pack ("kind": "packing").

${ITEM_RULES}`;

function itemList(items: string[] | undefined, empty: string): string {
  const capped = (items ?? []).slice(0, MAX_EXISTING_ITEMS);
  return capped.length > 0 ? capped.join(", ") : empty;
}

// "July" or "December to January", plus hemisphere context from latitude.
function timeOfYear(ctx: TripContext): string {
  const start = new Date(`${ctx.startDate}T00:00:00Z`);
  const end = new Date(`${ctx.endDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return "unknown";
  const startMonth = MONTHS[start.getUTCMonth()];
  const endMonth = Number.isNaN(end.getTime()) ? startMonth : MONTHS[end.getUTCMonth()];
  const months = startMonth === endMonth ? startMonth : `${startMonth} to ${endMonth}`;

  const lat = ctx.destinationLatitude;
  if (typeof lat !== "number") return months;
  if (Math.abs(lat) < 23.5) return `${months} (tropical latitude)`;
  return `${months} (${lat > 0 ? "Northern" : "Southern"} Hemisphere)`;
}

function weatherBlock(ctx: TripContext): string {
  if (!ctx.weather) {
    return "Weather: no forecast yet (trip is outside the forecast window); advise from destination and season.";
  }
  const days = ctx.weather.daily
    .map((d) => `  ${d.day}: ${d.lowC}–${d.highC}°C, ${d.condition}`)
    .join("\n");
  return `Weather (current ${ctx.weather.currentTempC}°C):\n${days}`;
}

function tripPrompt(ctx: TripContext): string {
  const lines = [
    `Trip name: ${ctx.tripName || "unnamed"}`,
    `Destination: ${ctx.destinationName || "unspecified"}`,
    ctx.originName ? `Leaving from: ${ctx.originName}` : null,
    `Dates: ${ctx.startDate} to ${ctx.endDate} (${ctx.durationDays} day(s))`,
    `Time of year: ${timeOfYear(ctx)}`,
    `Travel by: ${ctx.tripType || "unspecified"}`,
    `Staying in: ${ctx.accommodation || "unspecified"}`,
    `Number of packers: ${ctx.packerCount}`,
    ctx.listNames && ctx.listNames.length > 0 ? `Their lists: ${ctx.listNames.join(", ")}` : null,
    weatherBlock(ctx),
    "",
    `Already on their list, packed or not (do NOT re-suggest these): ${itemList(ctx.existingItems, "(nothing yet)")}`,
    ctx.otherPackersItems && ctx.otherPackersItems.length > 0
      ? `Other packers are bringing: ${itemList(ctx.otherPackersItems, "")}`
      : null,
  ];
  return `${TRIP_INSTRUCTIONS}

--- TRIP ---
${lines.filter((l) => l !== null).join("\n")}`;
}

function templatePrompt(ctx: TemplateContext): string {
  const kind = ctx.listKind === "tasks" ? "tasks (things to do)" : "packing (things to bring)";
  const lines = [
    `Template name: ${ctx.name || "unnamed"}`,
    `List kind: ${kind}`,
    ctx.isDayOf ? "Used on the day they leave (last-minute items or tasks)." : null,
    ctx.countAsDays ? "Counts are set from trip length when applied." : null,
    "",
    `Already on the template (do NOT re-suggest these): ${itemList(ctx.existingItems, "(empty)")}`,
  ];
  return `${TEMPLATE_INSTRUCTIONS}

--- TEMPLATE ---
${lines.filter((l) => l !== null).join("\n")}`;
}

export function buildSystemPrompt(req: AssistantRequest): string {
  return req.mode === "template" ? templatePrompt(req.templateContext) : tripPrompt(req.tripContext);
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
