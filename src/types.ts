// Shared types + the HTTP contract. Keep the request/response shapes in sync
// with the Swift DTOs in PackingHelper/Services/AIAssistantService.swift.

export interface Env {
  USAGE_KV: KVNamespace;
  // vars (wrangler.toml [vars])
  MODEL: string;
  MONTHLY_CAP: string;
  ENTITLEMENT_ID: string;
  // secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  REVENUECAT_SECRET_KEY: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface DailyWeather {
  day: string; // ISO date
  highC: number;
  lowC: number;
  condition: string;
}

export interface WeatherContext {
  currentTempC: number;
  daily: DailyWeather[];
}

export interface TripContext {
  destinationName: string;
  startDate: string; // ISO date
  endDate: string; // ISO date
  durationDays: number;
  tripType: string; // plane | car | train | boat | ferry
  accommodation: string; // hotel | rental | family | friend
  packerCount: number;
  existingItems: string[];
  weather?: WeatherContext; // omitted when unavailable (>5 days out, no data)
}

export interface AssistantRequest {
  rcAppUserId: string;
  tripContext: TripContext;
  messages: ChatMessage[];
}

export type SuggestionCategory =
  | "Clothing"
  | "Electronics"
  | "Toiletries"
  | "Task"
  | "other";

export type SuggestionKind = "packing" | "task";

export interface SuggestedItem {
  name: string;
  category: SuggestionCategory;
  count: number;
  kind: SuggestionKind;
  accessoryFor?: string;
}

// Shape the model is constrained to (structured outputs).
export interface ModelOutput {
  message: string;
  items: SuggestedItem[];
}

// Wire response added `remaining`.
export interface AssistantResponse extends ModelOutput {
  remaining: number;
}
