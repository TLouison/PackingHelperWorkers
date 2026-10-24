import type { Env, PhotoResult, PhotoSearchResponse } from "./types";

// Search results change slowly; a day of caching keeps popular destinations
// from spending the (shared, per-app) Unsplash hourly quota.
const SEARCH_CACHE_TTL = 60 * 60 * 24;
const PER_PAGE = 25;

export class UnsplashError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(`Unsplash HTTP ${status}`);
  }
}

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  color: string | null;
  blur_hash: string | null;
  urls: { raw: string; small: string };
  links: { html: string; download_location: string };
  user: { name: string; username: string; links: { html: string } };
}

interface UnsplashSearchBody {
  total_pages: number;
  results: UnsplashPhoto[];
}

function headers(env: Env): HeadersInit {
  return {
    Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}`,
    "Accept-Version": "v1",
  };
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function toResult(p: UnsplashPhoto): PhotoResult {
  return {
    id: p.id,
    width: p.width,
    height: p.height,
    color: p.color,
    blurHash: p.blur_hash,
    urls: { raw: p.urls.raw, small: p.urls.small },
    htmlLink: p.links.html,
    downloadLocation: p.links.download_location,
    photographer: {
      name: p.user.name,
      username: p.user.username,
      profileURL: p.user.links.html,
    },
  };
}

export async function searchPhotos(
  env: Env,
  query: string,
  page: number,
): Promise<PhotoSearchResponse> {
  const normalized = normalizeQuery(query);
  const cacheKey = `unsplash:search:v2:${normalized}:${page}`;
  const cached = await env.USAGE_KV.get<PhotoSearchResponse>(cacheKey, "json");
  if (cached) return cached;

  const url = new URL("https://api.unsplash.com/search/photos");
  url.searchParams.set("query", normalized);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(PER_PAGE));
  url.searchParams.set("orientation", "landscape");
  url.searchParams.set("content_filter", "high");

  const res = await fetch(url, { headers: headers(env) });
  if (!res.ok) {
    console.error("searchPhotos: Unsplash HTTP", res.status, await res.text());
    // Unsplash reports an exhausted hourly quota as 403 "Rate Limit Exceeded".
    throw new UnsplashError(res.status, res.status === 403 || res.status === 429);
  }

  const body = (await res.json()) as UnsplashSearchBody;
  const response: PhotoSearchResponse = {
    page,
    totalPages: body.total_pages,
    results: body.results.map(toResult),
  };
  await env.USAGE_KV.put(cacheKey, JSON.stringify(response), {
    expirationTtl: SEARCH_CACHE_TTL,
  });
  return response;
}

/**
 * Only Unsplash's own download-tracking endpoint is accepted, so this route
 * can't be used to make the Worker fetch arbitrary URLs.
 */
export function isValidDownloadLocation(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "api.unsplash.com" &&
    url.port === "" &&
    /^\/photos\/[A-Za-z0-9_-]+\/download$/.test(url.pathname)
  );
}

/** Required by the Unsplash API guidelines whenever a user selects a photo. */
export async function trackDownload(env: Env, downloadLocation: string): Promise<void> {
  const res = await fetch(downloadLocation, { headers: headers(env) });
  if (!res.ok) {
    console.error("trackDownload: Unsplash HTTP", res.status, await res.text());
    throw new UnsplashError(res.status, res.status === 403 || res.status === 429);
  }
}
