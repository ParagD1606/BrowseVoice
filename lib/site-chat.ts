/**
 * Client for the Browse Voice site knowledge service.
 *
 * The extension deliberately does not crawl pages itself. Crawling, chunking,
 * embeddings, and vector storage belong in the server-side knowledge service.
 * This client keeps that boundary small and provider-agnostic:
 *   POST /sites/index
 *   GET  /sites/index/:jobId
 *   POST /sites/chat
 */

export interface SiteChatConfig {
  endpoint: string;
  apiKey?: string;
  maxPages?: number;
}

export interface SiteIndexRequest {
  url: string;
  scope: "origin";
  maxPages: number;
}

export interface SiteIndexStartResponse {
  jobId: string;
  siteId?: string;
  status: SiteIndexStatus;
  pagesIndexed?: number;
  totalPages?: number;
  message?: string;
}

export type SiteIndexStatus = "queued" | "crawling" | "processing" | "ready" | "failed";

export interface SiteIndexProgress extends SiteIndexStartResponse {
  error?: string;
}

export interface SiteChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface SiteChatResponse {
  answer: string;
  sources?: Array<{ title?: string; url?: string; snippet?: string }>;
}

function getBaseUrl(config: SiteChatConfig): string {
  const endpoint = config.endpoint.trim().replace(/\/$/, "");
  if (!endpoint) throw new Error("Add a Site knowledge API endpoint in Settings first.");
  return endpoint;
}

function getHeaders(config: SiteChatConfig): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey?.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  return headers;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : undefined;
  } catch {
    parsed = undefined;
  }

  if (!response.ok) {
    const error = typeof parsed === "object" && parsed !== null
      ? (parsed as { error?: string; message?: string }).error || (parsed as { message?: string }).message
      : undefined;
    throw new Error(error || `Site knowledge service returned ${response.status}.`);
  }
  if (parsed === undefined) throw new Error("Site knowledge service returned an empty response.");
  return parsed as T;
}

function normalizeStatus(value: unknown): SiteIndexStatus {
  const status = String(value || "queued").toLowerCase();
  if (["ready", "complete", "completed", "done"].includes(status)) return "ready";
  if (["failed", "error"].includes(status)) return "failed";
  if (["processing", "embedding", "indexing"].includes(status)) return "processing";
  if (["crawling", "crawl"].includes(status)) return "crawling";
  return "queued";
}

function normalizeStartResponse(value: Record<string, unknown>): SiteIndexStartResponse {
  const jobId = String(value.jobId || value.indexJobId || value.job_id || value.id || "");
  if (!jobId) throw new Error("Site knowledge service did not return an indexing job ID.");
  return {
    jobId,
    siteId: typeof value.siteId === "string" ? value.siteId : typeof value.site_id === "string" ? value.site_id : undefined,
    status: normalizeStatus(value.status),
    pagesIndexed: typeof value.pagesIndexed === "number" ? value.pagesIndexed : typeof value.pages_indexed === "number" ? value.pages_indexed : undefined,
    totalPages: typeof value.totalPages === "number" ? value.totalPages : typeof value.total_pages === "number" ? value.total_pages : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
  };
}

function normalizeProgressResponse(value: Record<string, unknown>, jobId: string): SiteIndexProgress {
  return {
    ...normalizeStartResponse({ ...value, jobId }),
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

export async function startSiteIndexing(config: SiteChatConfig, startUrl: string): Promise<SiteIndexStartResponse> {
  const response = await fetch(`${getBaseUrl(config)}/sites/index`, {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify({
      url: startUrl,
      scope: "origin",
      maxPages: Math.min(Math.max(Math.round(config.maxPages || 25), 1), 250),
    } satisfies SiteIndexRequest),
  });
  return normalizeStartResponse(await readJson<Record<string, unknown>>(response));
}

export async function getSiteIndexProgress(config: SiteChatConfig, jobId: string): Promise<SiteIndexProgress> {
  const response = await fetch(`${getBaseUrl(config)}/sites/index/${encodeURIComponent(jobId)}`, {
    method: "GET",
    headers: getHeaders(config),
  });
  return normalizeProgressResponse(await readJson<Record<string, unknown>>(response), jobId);
}

export async function askSiteQuestion(
  config: SiteChatConfig,
  siteId: string,
  question: string,
  history: SiteChatHistoryEntry[],
): Promise<SiteChatResponse> {
  const response = await fetch(`${getBaseUrl(config)}/sites/chat`, {
    method: "POST",
    headers: getHeaders(config),
    body: JSON.stringify({ siteId, question, history }),
  });
  const data = await readJson<Record<string, unknown>>(response);
  const answer = typeof data.answer === "string"
    ? data.answer
    : typeof data.text === "string"
      ? data.text
      : typeof data.message === "string"
        ? data.message
        : "";
  if (!answer.trim()) throw new Error("The site knowledge service returned an empty answer.");
  const rawSources = Array.isArray(data.sources) ? data.sources : [];
  const sources = rawSources
    .filter((source): source is Record<string, unknown> => typeof source === "object" && source !== null)
    .map((source) => ({
      title: typeof source.title === "string" ? source.title : undefined,
      url: typeof source.url === "string" ? source.url : undefined,
      snippet: typeof source.snippet === "string" ? source.snippet : undefined,
    }));
  return { answer, sources };
}
