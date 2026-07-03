import { getEnv } from "@/lib/env";

const TAVILY_API_BASE = "https://api.tavily.com";
const DEFAULT_SEARCH_RESULTS = 5;
const DEFAULT_READ_MAX_CHARS = 12_000;

type TavilySearchResult = {
  content?: unknown;
  favicon?: unknown;
  raw_content?: unknown;
  score?: unknown;
  title?: unknown;
  url?: unknown;
};

type TavilySearchResponse = {
  answer?: unknown;
  query?: unknown;
  request_id?: unknown;
  response_time?: unknown;
  results?: unknown;
  usage?: unknown;
};

type TavilyExtractResult = {
  favicon?: unknown;
  images?: unknown;
  raw_content?: unknown;
  title?: unknown;
  url?: unknown;
};

type TavilyExtractResponse = {
  failed_results?: unknown;
  request_id?: unknown;
  response_time?: unknown;
  results?: unknown;
  usage?: unknown;
};

function envNumber(name: string, fallback: number) {
  const raw = getEnv(name);
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}\n...[truncated]`;
}

function webSearchConfig() {
  const provider = (getEnv("WEB_SEARCH_PROVIDER") ?? "tavily").toLowerCase();
  if (provider !== "tavily") {
    throw new Error(
      `Unsupported WEB_SEARCH_PROVIDER: ${provider}. Supported provider: tavily.`,
    );
  }

  const apiKey = getEnv("TAVILY_API_KEY");
  if (!apiKey) {
    throw new Error(
      "Missing web search configuration: add TAVILY_API_KEY to Vercel and Railway before using web.search or web.readPage.",
    );
  }

  return {
    apiKey,
    defaultMaxResults: boundedNumber(
      envNumber("WEB_SEARCH_MAX_RESULTS", DEFAULT_SEARCH_RESULTS),
      DEFAULT_SEARCH_RESULTS,
      1,
      10,
    ),
    readMaxChars: boundedNumber(
      envNumber("WEB_READ_MAX_CHARS", DEFAULT_READ_MAX_CHARS),
      DEFAULT_READ_MAX_CHARS,
      2_000,
      40_000,
    ),
  };
}

async function tavilyPost<T>(path: "/search" | "/extract", body: Record<string, unknown>) {
  const config = webSearchConfig();
  const response = await fetch(`${TAVILY_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();
  let parsed: unknown;
  try {
    parsed = responseText ? JSON.parse(responseText) : {};
  } catch {
    parsed = { message: responseText };
  }

  if (!response.ok) {
    const message =
      asString(asRecord(parsed).detail) ||
      asString(asRecord(parsed).error) ||
      asString(asRecord(parsed).message) ||
      `Tavily ${path} request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return parsed as T;
}

function publicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".local") ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0"
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

export async function searchWeb(input: {
  query: string;
  maxResults?: number;
  includeRawContent?: boolean;
}) {
  const config = webSearchConfig();
  const query = asString(input.query);
  if (!query) {
    throw new Error("web.search requires a non-empty query.");
  }

  const maxResults = boundedNumber(
    input.maxResults,
    config.defaultMaxResults,
    1,
    10,
  );
  const response = await tavilyPost<TavilySearchResponse>("/search", {
    query,
    search_depth: "basic",
    topic: "general",
    max_results: maxResults,
    include_answer: true,
    include_raw_content: input.includeRawContent ? "markdown" : false,
    include_images: false,
    include_favicon: true,
  });

  const results = asArray(response.results)
    .map((item, index) => {
      const result = item as TavilySearchResult;
      const url = publicHttpUrl(asString(result.url));
      if (!url) {
        return null;
      }

      const rawContent = asString(result.raw_content);
      return {
        evidenceId: `web:${index + 1}`,
        source: "web",
        title: asString(result.title, url),
        url,
        snippet: truncate(asString(result.content), 1_200),
        rawContent: rawContent
          ? truncate(rawContent, Math.min(config.readMaxChars, 6_000))
          : null,
        score:
          typeof result.score === "number" && Number.isFinite(result.score)
            ? result.score
            : null,
        favicon: asString(result.favicon) || null,
      };
    })
    .filter(Boolean);

  return {
    provider: "tavily",
    query,
    answer: truncate(asString(response.answer), 2_000),
    results,
    resultCount: results.length,
    requestId: asString(response.request_id) || null,
    responseTime: response.response_time ?? null,
    usage: response.usage ?? null,
  };
}

export async function readWebPage(input: { url: string; query?: string }) {
  const config = webSearchConfig();
  const url = publicHttpUrl(asString(input.url));
  if (!url) {
    throw new Error("web.readPage requires a public http(s) URL.");
  }

  const response = await tavilyPost<TavilyExtractResponse>("/extract", {
    urls: [url],
    extract_depth: "basic",
    format: "markdown",
    include_images: false,
    include_favicon: true,
    ...(asString(input.query) ? { query: asString(input.query), chunks_per_source: 5 } : {}),
  });
  const firstResult = asRecord(asArray(response.results)[0]) as TavilyExtractResult;
  const content = truncate(asString(firstResult.raw_content), config.readMaxChars);

  if (!content) {
    throw new Error(`No readable web page content returned for ${url}.`);
  }

  return {
    provider: "tavily",
    source: "web",
    title: asString(firstResult.title, url),
    url: asString(firstResult.url, url),
    content,
    contentLength: content.length,
    favicon: asString(firstResult.favicon) || null,
    failedResults: response.failed_results ?? [],
    requestId: asString(response.request_id) || null,
    responseTime: response.response_time ?? null,
    usage: response.usage ?? null,
  };
}
