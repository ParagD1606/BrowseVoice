import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractLinks, extractPage, validateStartUrl } from "../backend/crawler.mjs";
import { createLocalEmbedding } from "../backend/embeddings.mjs";
import { JsonVectorStore } from "../backend/vector-store.mjs";

test("extracts readable page text and same-origin links", () => {
  const html = `<html><head><title>Docs</title><script>ignore()</script></head><body><h1>Browse Voice</h1><p>Voice browser documentation.</p><a href="/guide">Guide</a><a href="https://other.example/">Other</a></body></html>`;
  const page = extractPage(html, "https://example.com/");
  assert.equal(page.title, "Docs");
  assert.match(page.text, /Browse Voice/);
  assert.deepEqual(extractLinks(html, "https://example.com/", "https://example.com"), ["https://example.com/guide"]);
});
test("rejects private crawler targets unless explicitly configured", () => {
  assert.throws(() => validateStartUrl("http://127.0.0.1:3000/"), /Private or local/);
  assert.equal(validateStartUrl("http://127.0.0.1:3000/", { allowPrivateNetworks: true }).hostname, "127.0.0.1");
});

test("persists local vectors and returns the most relevant chunk", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "browsevoice-vector-test-"));
  const store = new JsonVectorStore(path.join(dataDir, "vectors.json"));
  const records = [
    { id: "1", title: "Voice", url: "https://example.com/voice", text: "Voice commands control the browser.", embedding: createLocalEmbedding("Voice commands control the browser.") },
    { id: "2", title: "Payments", url: "https://example.com/payments", text: "Payment safety requires confirmation.", embedding: createLocalEmbedding("Payment safety requires confirmation.") },
  ];
  await store.replaceSite("site-1", records);
  const matches = store.search("site-1", createLocalEmbedding("How do voice commands work?"), 1);
  assert.equal(store.count("site-1"), 2);
  assert.equal(matches[0].record.id, "1");
});
