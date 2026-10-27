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
  UNSPLASH_ACCESS_KEY: string;
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
  tripName?: string;
  destinationName: string;
  destinationLatitude?: number; // for hemisphere / tropics
  originName?: string;
  startDate: string; // ISO date
  endDate: string; // ISO date
  durationDays: number;
  tripType: string; // comma-separated: plane, car, train, boat, ferry
  accommodation: string; // comma-separated: hotel, rental, with family, with friends
  packerCount: number;
  listNames?: string[];
  existingItems: string[]; // this packer's items + unassigned, packed or not
  otherPackersItems?: string[]; // what the trip's other packers are bringing
  weather?: WeatherContext; // omitted when unavailable (>5 days out, no data)
}

// A reusable template list, not tied to a trip.
export interface TemplateContext {
  name: string;
  listKind: "packing" | "tasks";
  isDayOf: boolean;
  countAsDays: boolean; // counts become the trip's length when applied
  existingItems: string[];
}

export type AssistantMode = "trip" | "template";

export type AssistantRequest =
  | { rcAppUserId: string; mode: "trip"; tripContext: TripContext; messages: ChatMessage[] }
  | { rcAppUserId: string; mode: "template"; templateContext: TemplateContext; messages: ChatMessage[] };

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

// MARK: Trip cover photos (Unsplash proxy). Keep in sync with
// PackingHelper/Services/UnsplashService.swift.

export interface PhotoSearchRequest {
  rcAppUserId: string;
  query: string;
  page: number;
}

export interface PhotoRandomRequest {
  rcAppUserId: string;
  query: string;
}

export interface PhotoDownloadRequest {
  rcAppUserId: string;
  downloadLocation: string;
}

export interface PhotoResult {
  id: string;
  width: number;
  height: number;
  color: string | null;
  blurHash: string | null;
  urls: { raw: string; small: string };
  htmlLink: string;
  downloadLocation: string;
  photographer: { name: string; username: string; profileURL: string };
}

export interface PhotoSearchResponse {
  page: number;
  totalPages: number;
  results: PhotoResult[];
}
