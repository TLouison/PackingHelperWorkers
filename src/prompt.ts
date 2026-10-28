import type { AssistantRequest, PastTrip, TemplateCandidate, TemplateContext, TripContext, TripList } from "./types";

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
- NEVER suggest anything already on any of their lists. An item on one list covers every list: don't suggest it again for a different list (sunscreen on "Toiletries" means no sunscreen for "Beach"). Treat plurals, brand names, and close synonyms as the same item ("Phone charger" = "iPhone charger" = "Charging cable"; "Toothbrush" covers "Electric toothbrush"). If in doubt, leave it out.
- Only suggest items you are highly confident this person will actually use. A short list of sure things beats a long list of maybes; usually 3-10 items, fewer is fine, and an empty list is fine when they're covered.
- Companions: look at what's already on their list and fill obvious gaps, the piece that item needs to be useful (toothbrush -> toothpaste; laptop -> laptop charger; camera -> spare battery or memory card; contact lenses -> lens solution and case; swimsuit -> sunscreen). Set "accessoryFor" to the existing item's name. Skip the companion if anything on any list already covers it.
- Keep "message" brief (1-3 sentences), friendly, and specific to them. For pure advice with nothing to add, return an empty "items" array.
- Items are only suggestions: nothing is added until the user picks it. Never say or imply you added, packed, or put anything on their list ("I've added", "I put", "Added"). Phrase them as suggestions ("You might want", "Consider", "Here are a few ideas").`;

const TRIP_INSTRUCTIONS = `You are an expert travel packing assistant embedded in a trip-packing app. You help the user decide what to pack and what to do before a trip, grounded in the trip details below.

Respond with a short, practical "message" plus a list of concrete suggested "items" for the user to choose from.

Use every trip detail:
- Destination and time of year: infer the likely climate and season (hemisphere matters; tropical places have wet and dry seasons). Use the forecast when provided.
- How they travel: flying means carry-on limits and liquids rules (travel-size toiletries, a neck pillow for long flights, chargers in the carry-on); driving allows bulkier items and car needs (snacks, phone mount, car charger); trains, boats, and ferries sit in between (motion sickness remedies on boats and ferries).
- Where they stay: hotels provide towels, shampoo, and hair dryers, so don't suggest those unless asked; rentals often lack basics (dish soap, laundry detergent, coffee filters); staying with family or friends suggests a host gift and slippers.
- The trip name and list names hint at the purpose (a wedding, a ski trip, a conference); plan for it.
- Scale "count" to trip duration (clothing) and number of packers. Use 1 for shared/single items.
- Other packers on the trip: shared items they're already bringing (sunscreen, adapters, first aid) are covered; personal items (toothbrush, clothes) are not.
- Each item goes on one of their lists: set "listId" to that list's id, exactly as given. Match the list's name and purpose (snorkel gear -> a Beach list; toiletries -> a Toiletries list). Tasks go only on tasks lists and things to pack only on packing lists. Day-of lists are for things done or grabbed the day they leave ("Charge phone", "Pack snacks for the car", "Take out the trash"); use one only when the item clearly belongs to that day. Never put an item on a list whose name doesn't fit it (a toothbrush doesn't go on a "Clothes" list). When nothing fits clearly, use their default list for things to pack if they have one; otherwise, and for tasks with no fitting tasks list, leave "listId" out and the app makes a new list for it. Never make up an id. Where an item goes doesn't change what counts as already covered: an item on any list covers every list.
- Templates: when a "Templates they could add" block is present, you may offer at most one of those templates in "template", set to its id exactly as given, and only when you're highly confident it fits this trip's purpose. Usually offer none. Never offer a template that isn't listed. "reason" is one short sentence specific to this trip, and may build on the listed reason ("You used it on Maui, another warm beach trip"). When you offer a template, don't also suggest items it contains, and mention it briefly in "message" ("Your Beach Weekend template looks like a fit"). A template doesn't count toward the item guidance below. If they ask whether any template fits and none clearly does, say so plainly and leave "template" out. With no templates block, always leave "template" out.
- Past trips (most similar first) show what this person actually brings. When a past trip is like this one (same kind of place, season, purpose, or transport), suggest the specific things they brought then, using their exact item names: their snacks, their gear, the lists they made themselves. Lists made on a trip (no template) are the strongest signal of personal habits. Items that show up on several past trips are safe bets. Skip items that only made sense for that trip (tickets, gifts for a specific event, a wedding outfit) and anything from a dissimilar trip. Set "fromTrip" to the past trip's name for these, and mention the trip in "message" when it helps ("Like your Maui trip, ...").

${ITEM_RULES}`;

const TEMPLATE_INSTRUCTIONS = `You are an expert travel packing assistant embedded in a trip-packing app. The user is building a reusable template list that they will apply to many future trips. There is no specific trip: no dates, destination, or weather.

Help them get a strong starting point:
- Work out what the list is for from its name and the conversation (e.g. "Beach", "Business Trip", "Toiletries", "Before I Leave"). If the name is too vague to know, suggest a short universal core and ask one short question in "message" about what kind of trips it's for.
- Suggest the essentials someone reliably needs for that kind of trip, not destination-specific extras. A template should hold what's packed every time.
- Group naturally: cover the main areas the list is for, but don't pad it. Usually 8-15 items for a first pass on an empty list, fewer when filling gaps.
- Use counts for one typical trip of this kind (often 1). If counts are set from trip length, use 1 for everything.
- Match the list kind: a tasks list gets only tasks ("kind": "task"), a packing list gets only things to pack ("kind": "packing").
- Past trips show what this person actually brings. Items they added on trips this template was used on (lists with this template's name, or lists they made themselves on similar trips) are strong candidates: things they keep adding by hand belong in the template. Prefer items that appear on more than one trip, use their exact names, and set "fromTrip" to a trip's name for these.

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
  const startMonth = MONTHS[start.getUTCMonth()] ?? "unknown";
  const endMonth = Number.isNaN(end.getTime()) ? startMonth : (MONTHS[end.getUTCMonth()] ?? startMonth);
  const months = startMonth === endMonth ? startMonth : `${startMonth} to ${endMonth}`;

  const lat = ctx.destinationLatitude;
  if (typeof lat !== "number") return months;
  if (Math.abs(lat) < 23.5) return `${months} (tropical latitude)`;
  return `${months} (${lat > 0 ? "Northern" : "Southern"} Hemisphere)`;
}

function pastTripsBlock(trips: PastTrip[] | undefined): string | null {
  if (!trips || trips.length === 0) return null;
  const blocks = trips.map((t) => {
    const header = `* ${t.name || "Trip"}: ${t.destinationName || "unknown destination"}, ${t.month}, ${t.durationDays} day(s), by ${t.tripType || "unspecified"}, staying in ${t.accommodation || "unspecified"}`;
    const lists = t.lists.map((l) => {
      const source = l.fromTemplate ? `from template "${l.fromTemplate}"` : "made on this trip";
      const kind = l.kind === "tasks" ? ", tasks" : "";
      return `    - ${l.name} (${source}${kind}): ${l.items.join(", ")}`;
    });
    return [header, ...lists].join("\n");
  });
  return `Past trips (items already on their lists at the start of this chat are left out):\n${blocks.join("\n")}`;
}

// Shares MAX_EXISTING_ITEMS across lists round-robin, so a long list can't crowd out the
// rest and every list keeps its first items.
function listItemBudgets(lists: TripList[]): number[] {
  const budgets = lists.map(() => 0);
  let remaining = MAX_EXISTING_ITEMS;
  for (let round = 0; remaining > 0; round++) {
    let added = false;
    lists.forEach((l, i) => {
      if (remaining > 0 && round < l.items.length) {
        budgets[i] = (budgets[i] ?? 0) + 1;
        remaining--;
        added = true;
      }
    });
    if (!added) break;
  }
  return budgets;
}

function listsBlock(lists: TripList[]): string {
  if (lists.length === 0) return "Their lists: (none yet)";
  const budgets = listItemBudgets(lists);
  const rows = lists.map((l, i) => {
    const kind = l.kind === "tasks" ? "tasks" : l.isDefault ? "everyday packing, default" : "packing";
    const details = [kind, l.isDayOf ? "day-of" : null, l.fromTemplate ? `from template "${l.fromTemplate}"` : null]
      .filter((d) => d !== null)
      .join(", ");
    const items = l.items.slice(0, budgets[i]);
    return `- ${l.id} · ${l.name} (${details}): ${items.length > 0 ? items.join(", ") : "(empty)"}`;
  });
  const noDefault = lists.some((l) => l.isDefault) ? "" : "\nThey have no default list.";
  return `Their lists, as id · name (kind): items already on it, packed or not. Do NOT re-suggest any of these items for any list.\n${rows.join("\n")}${noDefault}`;
}

// Only templates the app found a hard reason for (used on a similar trip, name match, or much
// of it already on the trip). In the uncached current state: they drop out once applied or offered.
function templatesBlock(candidates: TemplateCandidate[] | undefined): string | null {
  if (!candidates || candidates.length === 0) return null;
  const rows = candidates.map((t) => {
    const kind = [t.kind === "tasks" ? "tasks" : "packing", t.isDayOf ? "day-of" : null]
      .filter((d) => d !== null)
      .join(", ");
    const details = [`${kind}, ${t.itemCount} item(s)`, ...t.signals].join("; ");
    return `- ${t.id} · ${t.name} (${details}): ${t.items.join(", ")}`;
  });
  return `Templates they could add, as id · name (kind, size; why it may fit): first items. Offer at most one, only if it clearly fits.\n${rows.join("\n")}`;
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

/**
 * The system prompt in three parts, ordered from most to least stable so the Worker can
 * cache the prefix:
 * - `instructions`: the same for every request in a mode (cached across all users).
 * - `context`: trip or template facts and past trips, which the app keeps fixed for a chat
 *   session (cached across the conversation).
 * - `currentState`: what's on their lists right now, which changes whenever they add an
 *   item. Sent after the conversation as a mid-conversation system message, so it never
 *   invalidates the cached history.
 */
export interface PromptParts {
  instructions: string;
  context: string;
  currentState: string;
}

function tripPrompt(ctx: TripContext): PromptParts {
  const lines = [
    `Trip name: ${ctx.tripName || "unnamed"}`,
    `Destination: ${ctx.destinationName || "unspecified"}`,
    ctx.originName ? `Leaving from: ${ctx.originName}` : null,
    `Dates: ${ctx.startDate} to ${ctx.endDate} (${ctx.durationDays} day(s))`,
    `Time of year: ${timeOfYear(ctx)}`,
    `Travel by: ${ctx.tripType || "unspecified"}`,
    `Staying in: ${ctx.accommodation || "unspecified"}`,
    `Number of packers: ${ctx.packerCount}`,
    weatherBlock(ctx),
    pastTripsBlock(ctx.pastTrips),
  ];
  const state = [
    ...(ctx.lists
      ? [listsBlock(ctx.lists)]
      : [
          ctx.listNames && ctx.listNames.length > 0 ? `Their lists: ${ctx.listNames.join(", ")}` : null,
          `Already on their lists, across every list on this trip, packed or not (do NOT re-suggest these for any list): ${itemList(ctx.existingItems, "(nothing yet)")}`,
        ]),
    ctx.otherPackersItems && ctx.otherPackersItems.length > 0
      ? `Other packers are bringing: ${itemList(ctx.otherPackersItems, "")}`
      : null,
    templatesBlock(ctx.templateCandidates),
  ];
  return {
    instructions: TRIP_INSTRUCTIONS,
    context: `--- TRIP ---\n${lines.filter((l) => l !== null).join("\n")}`,
    currentState: `--- THEIR LISTS RIGHT NOW (replaces anything said earlier about their lists) ---\n${state.filter((l) => l !== null).join("\n")}`,
  };
}

function templatePrompt(ctx: TemplateContext): PromptParts {
  const kind = ctx.listKind === "tasks" ? "tasks (things to do)" : "packing (things to bring)";
  const lines = [
    `Template name: ${ctx.name || "unnamed"}`,
    `List kind: ${kind}`,
    ctx.isDayOf ? "Used on the day they leave (last-minute items or tasks)." : null,
    ctx.countAsDays ? "Counts are set from trip length when applied." : null,
    pastTripsBlock(ctx.pastTrips),
  ];
  return {
    instructions: TEMPLATE_INSTRUCTIONS,
    context: `--- TEMPLATE ---\n${lines.filter((l) => l !== null).join("\n")}`,
    currentState: `--- THE TEMPLATE RIGHT NOW (replaces anything said earlier about it) ---\nAlready on the template (do NOT re-suggest these): ${itemList(ctx.existingItems, "(empty)")}`,
  };
}

export function buildPrompt(req: AssistantRequest): PromptParts {
  return req.mode === "template" ? templatePrompt(req.templateContext) : tripPrompt(req.tripContext);
}

// Structured-output schema. Constraints kept within what structured outputs
// support: additionalProperties:false everywhere, enums, no min/max.
// accessoryFor, fromTrip, listId, and template are optional (omitted from "required").
// Template mode's prompt never mentions listId or template.
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
          fromTrip: { type: "string" },
          listId: { type: "string" },
        },
        required: ["name", "category", "count", "kind"],
        additionalProperties: false,
      },
    },
    template: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id", "reason"],
      additionalProperties: false,
    },
  },
  required: ["message", "items"],
  additionalProperties: false,
} as const;
