import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { crawlSite, validateStartUrl } from "./crawler.mjs";
import { embedTexts } from "./embeddings.mjs";
import { answerQuestion } from "./llm.mjs";
import { JsonVectorStore } from "./vector-store.mjs";

function now() {
  return new Date().toISOString();
}
function publicJob(job) {
  return {
    jobId: job.jobId,
    siteId: job.siteId,
    status: job.status,
    pagesIndexed: job.pagesIndexed,
    totalPages: job.totalPages,
    message: job.message,
    error: job.error,
  };
}

function limitText(value, max) {
  return String(value || "").trim().slice(0, max);
}

export class KnowledgeService {
  constructor(config) {
    this.config = config;
    this.jobs = new Map();
    this.sites = new Map();
    this.jobsFile = path.join(config.dataDir, "jobs.json");
    this.sitesFile = path.join(config.dataDir, "sites.json");
    this.vectorStore = new JsonVectorStore(path.join(config.dataDir, "vectors.json"));
  }

  async init() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await this.vectorStore.load();
    await this.loadMap(this.jobsFile, this.jobs);
    await this.loadMap(this.sitesFile, this.sites);
    for (const job of this.jobs.values()) {
      if (["queued", "crawling", "processing"].includes(job.status)) {
        job.status = "failed";
        job.error = "The server restarted while this indexing job was running.";
        job.message = job.error;
      }
    }
    await this.persistJobs();
  }

  async loadMap(filePath, destination) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
      for (const [key, value] of Object.entries(parsed)) destination.set(key, value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  async persistJobs() {
    await fs.writeFile(this.jobsFile, JSON.stringify(Object.fromEntries(this.jobs), null, 2), "utf8");
  }

  async persistSites() {
    await fs.writeFile(this.sitesFile, JSON.stringify(Object.fromEntries(this.sites), null, 2), "utf8");
  }

  async startIndexing({ url, maxPages }) {
    if (typeof url !== "string" || !url.trim()) throw Object.assign(new Error("A site URL is required."), { statusCode: 400 });
    let startUrl;
    try {
      startUrl = validateStartUrl(url, { allowPrivateNetworks: this.config.allowPrivateNetworks });
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : "Invalid site URL."), { statusCode: 400 });
    }
    const pageLimit = Math.min(Math.max(Number(maxPages) || this.config.maxPages, 1), this.config.maxPages);
    const jobId = crypto.randomUUID();
    const siteId = crypto.randomUUID();
    const job = {
      jobId,
      siteId,
      startUrl: startUrl.href,
      origin: startUrl.origin,
      status: "queued",
      pagesIndexed: 0,
      totalPages: pageLimit,
      message: "Crawler queued.",
      createdAt: now(),
      updatedAt: now(),
    };
    this.jobs.set(jobId, job);
    this.sites.set(siteId, { siteId, origin: startUrl.origin, startUrl: startUrl.href, jobId, status: "indexing", createdAt: now() });
    await Promise.all([this.persistJobs(), this.persistSites()]);
    void this.runIndexing(job, pageLimit);
    return publicJob(job);
  }

  async runIndexing(job, pageLimit) {
    try {
      job.status = "crawling";
      job.message = "Crawler is fetching pages.";
      await this.persistJobs();
      const result = await crawlSite({
        startUrl: job.startUrl,
        maxPages: pageLimit,
        config: this.config,
        onProgress: async (progress) => {
          job.pagesIndexed = progress.pagesIndexed;
          job.message = progress.currentUrl ? `Fetched ${progress.currentUrl}` : "Crawler is fetching pages.";
          job.updatedAt = now();
          await this.persistJobs();
        },
      });
      if (!result.chunks.length) throw new Error("The crawler found no readable HTML content on this site.");
      job.status = "processing";
      job.message = `Creating embeddings for ${result.chunks.length} content chunks.`;
      job.updatedAt = now();
      await this.persistJobs();
      const vectors = await embedTexts(this.config, result.chunks.map((chunk) => `${chunk.title}\n${chunk.text}`));
      if (vectors.length !== result.chunks.length) throw new Error("Embedding service returned an incomplete vector set.");
      await this.vectorStore.replaceSite(job.siteId, result.chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })));
      job.status = "ready";
      job.pagesIndexed = result.pages.length;
      job.message = `Indexed ${result.pages.length} pages and ${result.chunks.length} chunks.`;
      job.updatedAt = now();
      const site = this.sites.get(job.siteId);
      if (site) Object.assign(site, { status: "ready", pagesIndexed: result.pages.length, chunkCount: result.chunks.length, updatedAt: now() });
      await Promise.all([this.persistJobs(), this.persistSites()]);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Indexing failed.";
      job.message = job.error;
      job.updatedAt = now();
      const site = this.sites.get(job.siteId);
      if (site) Object.assign(site, { status: "failed", updatedAt: now() });
      await Promise.all([this.persistJobs(), this.persistSites()]);
    }
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return publicJob(job);
  }

  async chat({ siteId, question, history = [] }) {
    const site = this.sites.get(siteId);
    if (!site) throw Object.assign(new Error("Site knowledge base not found."), { statusCode: 404 });
    if (site.status !== "ready") throw Object.assign(new Error("This site is still being indexed."), { statusCode: 409 });
    const cleanQuestion = limitText(question, 2_000);
    if (!cleanQuestion) throw Object.assign(new Error("Question is required."), { statusCode: 400 });
    const queryVectors = await embedTexts(this.config, [cleanQuestion]);
    const results = this.vectorStore.search(siteId, queryVectors[0], this.config.searchLimit);
    const answer = await answerQuestion(this.config, cleanQuestion, Array.isArray(history) ? history.slice(-8) : [], results);
    return {
      answer,
      sources: results.map(({ record, score }) => ({ title: record.title, url: record.url, snippet: record.text.slice(0, 300), score: Number(score.toFixed(4)) })),
    };
  }
}
