import net from "node:net";

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
function cleanText(html) {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|main|li|h[1-6]|br|tr|td|th)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " "))
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function getTitle(html, fallbackUrl) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return decodeEntities(match?.[1] || "").replace(/\s+/g, " ").trim() || new URL(fallbackUrl).hostname;
}

export function extractPage(html, url) {
  const title = getTitle(html, url);
  const text = cleanText(html);
  return { title, text };
}

export function extractLinks(html, pageUrl, origin) {
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const link = new URL(decodeEntities(match[1]), pageUrl);
      link.hash = "";
      if (["http:", "https:"].includes(link.protocol) && link.origin === origin) links.add(link.href);
    } catch {
      // Ignore malformed links.
    }
  }
  return [...links];
}

function isPrivateHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower === "0.0.0.0") return true;
  const ipVersion = net.isIP(lower);
  if (ipVersion === 4) {
    const parts = lower.split(".").map(Number);
    return parts[0] === 10 || parts[0] === 127 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 169 && parts[1] === 254;
  }
  if (ipVersion === 6) return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  return false;
}

export function validateStartUrl(value, { allowPrivateNetworks = false } = {}) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http and https site URLs can be crawled.");
  if (isPrivateHost(url.hostname) && !allowPrivateNetworks) throw new Error("Private or local network URLs cannot be crawled.");
  url.hash = "";
  return url;
}

async function fetchHtml(url, config) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": config.userAgent },
    });
    const finalUrl = new URL(response.url || url);
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) return null;
    if (finalUrl.origin !== new URL(url).origin || isPrivateHost(finalUrl.hostname) && !config.allowPrivateNetworks) return null;
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > config.maxPageBytes) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > config.maxPageBytes) return null;
    return { url: finalUrl.href, html: buffer.toString("utf8") };
  } finally {
    clearTimeout(timeout);
  }
}

function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const chunk = text.slice(start, end).trim();
    if (chunk.length >= 20) chunks.push(chunk);
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export async function crawlSite({ startUrl, maxPages, config, onProgress }) {
  const initialUrl = validateStartUrl(startUrl, { allowPrivateNetworks: config.allowPrivateNetworks });
  const origin = initialUrl.origin;
  const queue = [initialUrl.href];
  const queued = new Set(queue);
  const visited = new Set();
  const pages = [];
  const chunks = [];

  while (queue.length && pages.length < maxPages) {
    const currentUrl = queue.shift();
    if (visited.has(currentUrl)) continue;
    visited.add(currentUrl);
    try {
      const result = await fetchHtml(currentUrl, config);
      if (!result) continue;
      const page = extractPage(result.html, result.url);
      if (!page.text) continue;
      pages.push({ url: result.url, title: page.title, characters: page.text.length });
      for (const text of chunkText(page.text, config.chunkSize, config.chunkOverlap)) {
        chunks.push({ id: `${pages.length}-${chunks.length}`, url: result.url, title: page.title, text });
      }
      for (const link of extractLinks(result.html, result.url, origin)) {
        if (!queued.has(link) && !visited.has(link) && queue.length + pages.length < maxPages * 4) {
          queued.add(link);
          queue.push(link);
        }
      }
      await onProgress?.({ pagesIndexed: pages.length, totalPages: maxPages, currentUrl: result.url });
    } catch (error) {
      await onProgress?.({ pagesIndexed: pages.length, totalPages: maxPages, currentUrl, warning: error instanceof Error ? error.message : "Page fetch failed." });
    }
  }

  return { origin, pages, chunks };
}
