import assert from "node:assert/strict";
import test from "node:test";
import { checkSiteSafety } from "../backend/safety-checker.mjs";

const config = {
  allowPrivateNetworks: false,
  requestTimeoutMs: 2_000,
  userAgent: "BrowseVoiceSafetyTest/1.0",
  googleSafeBrowsingKey: "",
};

test("returns explainable risk signals for an insecure and suspicious hostname", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><body><h1>Sign in</h1></body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
  try {
    const result = await checkSiteSafety("http://login.example.com/account", config);
    assert.equal(result.verdict, "high-risk");
    assert.ok(result.reasons.some((reason) => reason.title === "The site does not use HTTPS"));
    assert.ok(result.reasons.some((reason) => reason.title === "The hostname contains a sensitive-action keyword"));
    assert.equal(result.checks.find((check) => check.id === "reputation")?.status, "info");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not probe private network targets by default", async () => {
  const result = await checkSiteSafety("http://127.0.0.1:8787", config);
  assert.equal(result.verdict, "high-risk");
  assert.match(result.reasons[0].detail, /Private or local/);
});

test("does not follow a public-site redirect into a private network", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8787/admin" } });
  };
  try {
    const result = await checkSiteSafety("https://example.com", config);
    assert.equal(calls, 1);
    assert.equal(result.verdict, "unknown");
    assert.match(result.reasons[0].detail, /Private or local/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
