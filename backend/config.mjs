import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function loadDotEnv(filePath = path.resolve(process.cwd(), ".env")) {
  try {
    const source = fs.readFileSync(filePath, "utf8");
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      const rawValue = line.slice(separator + 1).trim();
      if (!process.env[key]) process.env[key] = rawValue.replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
loadDotEnv();

function numberEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function listEnv(name, fallback = []) {
  const value = process.env[name];
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

export function createConfig(overrides = {}) {
  return {
    host: process.env.SITE_CHAT_HOST || "127.0.0.1",
    port: numberEnv("SITE_CHAT_PORT", 8787, 1, 65535),
    dataDir: path.resolve(process.env.SITE_CHAT_DATA_DIR || path.resolve(process.cwd(), "backend/data")),
    maxPages: numberEnv("SITE_CHAT_MAX_PAGES", 25, 1, 250),
    maxPageBytes: numberEnv("SITE_CHAT_MAX_PAGE_BYTES", 2_000_000, 100_000, 10_000_000),
    requestTimeoutMs: numberEnv("SITE_CHAT_REQUEST_TIMEOUT_MS", 15_000, 1_000, 120_000),
    allowPrivateNetworks: process.env.SITE_CHAT_ALLOW_PRIVATE_NETWORKS === "true",
    chunkSize: numberEnv("SITE_CHAT_CHUNK_SIZE", 1_600, 400, 8_000),
    chunkOverlap: numberEnv("SITE_CHAT_CHUNK_OVERLAP", 240, 0, 1_000),
    searchLimit: numberEnv("SITE_CHAT_SEARCH_LIMIT", 6, 1, 20),
    embeddingProvider: process.env.SITE_CHAT_EMBEDDING_PROVIDER || "local",
    embeddingEndpoint: process.env.SITE_CHAT_EMBEDDING_ENDPOINT || process.env.LLM_ENDPOINT || "https://api.openai.com/v1",
    embeddingApiKey: process.env.SITE_CHAT_EMBEDDING_API_KEY || process.env.LLM_API_KEY || "",
    embeddingModel: process.env.SITE_CHAT_EMBEDDING_MODEL || "",
    embeddingDimensions: numberEnv("SITE_CHAT_EMBEDDING_DIMENSIONS", 384, 64, 3_072),
    llmProvider: process.env.SITE_CHAT_LLM_PROVIDER || "none",
    llmEndpoint: process.env.SITE_CHAT_LLM_ENDPOINT || process.env.LLM_ENDPOINT || "https://api.openai.com/v1",
    llmGeminiEndpoint: process.env.SITE_CHAT_GEMINI_ENDPOINT || "https://generativelanguage.googleapis.com/v1beta",
    llmApiKey: process.env.SITE_CHAT_LLM_API_KEY || process.env.LLM_API_KEY || "",
    llmModel: process.env.SITE_CHAT_LLM_MODEL || process.env.LLM_MODEL || "",
    serverApiKey: process.env.SITE_CHAT_API_KEY || "",
    corsOrigins: listEnv("SITE_CHAT_CORS_ORIGINS", ["*"]),
    userAgent: process.env.SITE_CHAT_USER_AGENT || "BrowseVoiceKnowledgeCrawler/1.0",
    ...overrides,
  };
}
