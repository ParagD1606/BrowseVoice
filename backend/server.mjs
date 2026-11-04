import http from "node:http";
import { pathToFileURL } from "node:url";
import { createConfig } from "./config.mjs";
import { KnowledgeService } from "./service.mjs";
import { checkSiteSafety } from "./safety-checker.mjs";

function json(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}
function getCorsHeaders(request, config) {
  const origin = request.headers.origin;
  const allowed = config.corsOrigins.includes("*") || origin && config.corsOrigins.includes(origin) ? origin || "*" : "";
  return allowed ? { "Access-Control-Allow-Origin": allowed, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", Vary: "Origin" } : {};
}

function isAuthorized(request, config) {
  if (!config.serverApiKey) return true;
  return request.headers.authorization === `Bearer ${config.serverApiKey}`;
}

async function readBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

function routePath(url) {
  return new URL(url, "http://localhost").pathname.replace(/\/$/, "") || "/";
}

export async function createServer(config = createConfig()) {
  const knowledge = new KnowledgeService(config);
  await knowledge.init();
  const server = http.createServer(async (request, response) => {
    const cors = getCorsHeaders(request, config);
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (Object.keys(cors).length === 0 && request.headers.origin) {
      json(response, 403, { error: "Origin is not allowed." });
      return;
    }
    if (!isAuthorized(request, config)) {
      json(response, 401, { error: "Unauthorized." }, cors);
      return;
    }

    try {
      const path = routePath(request.url);
      if (request.method === "GET" && path === "/health") {
        json(response, 200, { ok: true, service: "browsevoice-site-knowledge" }, cors);
        return;
      }
      if (request.method === "POST" && path === "/sites/index") {
        const body = await readBody(request);
        const job = await knowledge.startIndexing({ url: body.url, maxPages: body.maxPages });
        json(response, 202, job, cors);
        return;
      }
      const progressMatch = path.match(/^\/sites\/index\/([^/]+)$/);
      if (request.method === "GET" && progressMatch) {
        const job = knowledge.getJob(decodeURIComponent(progressMatch[1]));
        if (!job) {
          json(response, 404, { error: "Indexing job not found." }, cors);
          return;
        }
        json(response, 200, job, cors);
        return;
      }
      if (request.method === "POST" && path === "/sites/chat") {
        const body = await readBody(request);
        const result = await knowledge.chat(body);
        json(response, 200, result, cors);
        return;
      }
      if (request.method === "POST" && path === "/sites/safety") {
        const body = await readBody(request);
        const result = await checkSiteSafety(body.url, config);
        json(response, 200, result, cors);
        return;
      }
      json(response, 404, { error: "Route not found." }, cors);
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      json(response, statusCode, { error: statusCode >= 500 ? "Internal knowledge service error." : error.message }, cors);
      if (statusCode >= 500) console.error(error);
    }
  });
  return { server, knowledge, config };
}

export async function startServer(config = createConfig()) {
  const app = await createServer(config);
  await new Promise((resolve) => app.server.listen(config.port, config.host, resolve));
  console.log(`Browse Voice site knowledge service listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
