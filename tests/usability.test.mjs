import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { answerAboutPage, buildPlannerPrompt } from "../lib/planner.ts";

test("executor uses the native input/textarea setter before input and change events", async () => {
  const source = await readFile(new URL("../content/executor.ts", import.meta.url), "utf8");
  assert.match(source, /Object\.getOwnPropertyDescriptor\(prototype, "value"\)\?\.set/);
  assert.match(source, /setNativeElementValue\(el, action\.text\)/);
  assert.match(source, /dispatchEvent\(new InputEvent\("input"/);
  assert.match(source, /dispatchEvent\(new Event\("change"/);
  assert.match(source, /case "press_key"/);
  assert.match(source, /keydown/);
  assert.match(source, /keypress/);
  assert.match(source, /keyup/);
});

test("page questions use visible page context and planner prompts retain up to 30 controls", async () => {
  const snapshot = {
    url: "https://example.com",
    title: "Meaning",
    summary: "This page explains the annual subscription and receipt status.",
    timestamp: Date.now(),
    interactiveElements: Array.from({ length: 31 }, (_, index) => ({ id: index + 1, tag: "button", role: "button", label: `Control ${index + 1}`, isSensitive: false })),
  };
  const answer = await answerAboutPage({ provider: "mock" }, "what does this mean", snapshot);
  assert.match(answer.text, /annual subscription/);
  const prompt = JSON.parse(buildPlannerPrompt({ userRequest: "click a control", snapshot, history: [] }));
  assert.equal(prompt.page.controls.length, 30);
});

test("observer receipt detection is generic rather than demo-selector based", async () => {
  const source = await readFile(new URL("../content/observer.ts", import.meta.url), "utf8");
  assert.match(source, /hasPaymentReceipt\(fullBodyText\)/);
  assert.doesNotMatch(source, /section-receipt|data-payment-receipt|bill-amount|status-badge/);
});

test("housekeeping keeps promotional media ignored and makes build typecheck first", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const app = await readFile(new URL("../sidepanel/App.tsx", import.meta.url), "utf8");
  assert.match(packageJson.scripts.build, /^npm run typecheck &&/);
  assert.match(ignore, /^promo\/$/m);
  assert.doesNotMatch(app, /Legacy single-tab loop/);
});
