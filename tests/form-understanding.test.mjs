/**
 * Universal form understanding, answer resolution, verification, and planner
 * transparency tests for Browse Voice.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildFillAction,
  buildHeuristicQuestion,
  collectFormFields,
  findFormField,
  isFormFillIntent,
  matchOption,
  mergeFormSessionFields,
  parseYesNo,
  resolveFormAnswer,
  understandFormFields,
  verifyFilledValue,
} from "../lib/form-model.ts";
import { createPlanner, describePlannerMode, resolvePlanner } from "../lib/planner.ts";
import { inspectActionSafety } from "../lib/safety.ts";

function googleFormsLikeSnapshot() {
  return {
    url: "https://example.test/forms/internship",
    title: "Internship Application (Google Forms–like fixture)",
    summary: "Internship Application | Full Name | Email | highest educational qualification | relocate | programming language",
    timestamp: Date.now(),
    interactiveElements: [
      {
        id: 1, tag: "input", role: "textbox", label: "Full Name", type: "text", name: "full_name",
        question: "Full Name", controlKind: "text", required: true, interactable: true, visible: true, isSensitive: false, value: "",
      },
      {
        id: 2, tag: "input", role: "textbox", label: "Email", type: "email", name: "email",
        question: "Email", controlKind: "email", required: true, interactable: true, visible: true, isSensitive: false, value: "",
      },
      {
        id: 3, tag: "div", role: "radio", label: "High School", type: undefined, name: "education",
        question: "What is your highest educational qualification?", controlKind: "radio", groupName: "education",
        required: true, interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 4, tag: "div", role: "radio", label: "Bachelor's", type: undefined, name: "education",
        question: "What is your highest educational qualification?", controlKind: "radio", groupName: "education",
        required: true, interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 5, tag: "div", role: "radio", label: "Master's", type: undefined, name: "education",
        question: "What is your highest educational qualification?", controlKind: "radio", groupName: "education",
        required: true, interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 6, tag: "button", role: "combobox", label: "Choose", question: "Select your preferred programming language",
        controlKind: "combobox", options: ["JavaScript", "Python", "Java", "Go"], interactable: true, visible: true, isSensitive: false, value: "",
      },
      {
        id: 7, tag: "div", role: "radio", label: "Yes", question: "Are you willing to relocate?", controlKind: "radio",
        groupName: "relocate", name: "relocate", required: true, interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 8, tag: "div", role: "radio", label: "No", question: "Are you willing to relocate?", controlKind: "radio",
        groupName: "relocate", name: "relocate", required: true, interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 9, tag: "textarea", role: "textbox", label: "Why do you want to join this internship?", type: undefined,
        question: "Why do you want to join this internship?", controlKind: "textarea", interactable: true, visible: true, isSensitive: false, value: "",
      },
      {
        id: 10, tag: "div", role: "checkbox", label: "I agree to the terms", question: "I agree to the terms",
        controlKind: "checkbox", interactable: true, visible: true, isSensitive: false, checked: false,
      },
      {
        id: 11, tag: "input", role: "textbox", label: "Account password", type: "password", name: "password",
        question: "Account password", controlKind: "password", interactable: true, visible: true, isSensitive: true,
        sensitiveReason: "Password field (input[type=password])", value: "",
      },
      {
        id: 12, tag: "button", role: "button", label: "Submit", type: "submit", controlKind: "button",
        interactable: true, visible: true, isSensitive: false,
      },
      {
        id: 13, tag: "select", role: "combobox", label: "Native course", question: "Native course", controlKind: "select",
        options: ["CSE", "ECE", "ME"], selected: "", interactable: true, visible: true, isSensitive: false, value: "",
      },
      {
        id: 14, tag: "input", role: "checkbox", label: "Subscribe to newsletter", type: "checkbox", controlKind: "checkbox",
        question: "Subscribe to newsletter", interactable: true, visible: true, isSensitive: false, checked: false,
      },
    ],
  };
}

test("form fill intent detection covers English and Hindi phrasing", () => {
  assert.equal(isFormFillIntent("fill this form"), true);
  assert.equal(isFormFillIntent("apply for this internship"), true);
  assert.equal(isFormFillIntent("फॉर्म भरें"), true);
  assert.equal(isFormFillIntent("scroll down"), false);
});

test("collectFormFields understands native + custom ARIA Google Forms–like controls", () => {
  const { fields, manualFields } = collectFormFields(googleFormsLikeSnapshot());
  const questions = fields.map((field) => field.question);

  assert.ok(questions.some((question) => /full name/i.test(question)));
  assert.ok(questions.some((question) => /highest educational qualification/i.test(question)));
  assert.ok(questions.some((question) => /preferred programming language/i.test(question)));
  assert.ok(questions.some((question) => /willing to relocate/i.test(question)));
  assert.ok(questions.some((question) => /why do you want to join/i.test(question)));
  assert.ok(fields.some((field) => field.kind === "radio" && field.options?.includes("Bachelor's")));
  assert.ok(fields.some((field) => field.kind === "combobox" && field.options?.includes("Python")));
  assert.ok(fields.some((field) => field.kind === "select" && field.options?.includes("CSE")));
  assert.ok(fields.some((field) => field.kind === "checkbox"));
  assert.ok(fields.some((field) => field.kind === "text" && /email/i.test(field.question)));
  assert.ok(manualFields.some((field) => /password/i.test(field.label)));
  assert.equal(fields.some((field) => /submit/i.test(field.label)), false, "Submit button must not be auto-filled");
});

test("heuristic questions use the real form question instead of generic templates", () => {
  const { fields } = collectFormFields(googleFormsLikeSnapshot());
  const education = fields.find((field) => /highest educational qualification/i.test(field.question));
  const why = fields.find((field) => /why do you want/i.test(field.question));
  assert.ok(education);
  assert.ok(why);
  const educationQuestion = buildHeuristicQuestion(education, "en-IN");
  const whyQuestion = buildHeuristicQuestion(why, "en-IN");
  assert.match(educationQuestion, /highest educational qualification/i);
  assert.doesNotMatch(educationQuestion, /what should i enter for this field/i);
  assert.match(whyQuestion, /why do you want to join this internship/i);
});

test("answer resolver maps Hindi yes/no and option matching without inventing choices", () => {
  assert.equal(parseYesNo("haan"), true);
  assert.equal(parseYesNo("नहीं"), false);
  assert.equal(matchOption(["Yes", "No"], "haan"), "Yes");
  assert.equal(matchOption(["JavaScript", "Python", "Java"], "python"), "Python");
  assert.equal(matchOption(["JavaScript", "Python", "Java"], "ruby"), undefined);

  const radioField = collectFormFields(googleFormsLikeSnapshot()).fields.find((field) => /relocate/i.test(field.question));
  const matched = resolveFormAnswer(radioField, "haan");
  assert.equal(matched.status, "matched");
  assert.equal(matched.value, "Yes");

  const invalid = resolveFormAnswer(radioField, "maybe later");
  assert.equal(invalid.status, "ambiguous");
});

test("findFormField resolves custom radio options from a fresh snapshot", () => {
  const snapshot = googleFormsLikeSnapshot();
  const { fields } = collectFormFields(snapshot);
  const education = fields.find((field) => /educational qualification/i.test(field.question));
  const target = findFormField(snapshot, education, "Bachelor's");
  assert.ok(target);
  assert.equal(target.label, "Bachelor's");
  assert.equal(target.controlKind, "radio");
});

test("buildFillAction and verifyFilledValue cover text, checkbox, radio, and select", () => {
  const snapshot = googleFormsLikeSnapshot();
  const { fields } = collectFormFields(snapshot);
  const nameField = fields.find((field) => /full name/i.test(field.question));
  const nameElement = findFormField(snapshot, nameField);
  const typeAction = buildFillAction(nameField, nameElement, { status: "matched", value: "Asha Verma" });
  assert.deepEqual(typeAction, { action: "type", id: 1, text: "Asha Verma" });

  const typedElement = { ...nameElement, value: "Asha Verma" };
  assert.equal(verifyFilledValue(typedElement, nameField, { status: "matched", value: "Asha Verma" }).ok, true);
  assert.equal(verifyFilledValue({ ...nameElement, value: "" }, nameField, { status: "matched", value: "Asha Verma" }).ok, false);

  const checkbox = fields.find((field) => field.kind === "checkbox" && /newsletter|agree/i.test(field.question + field.label));
  const checkboxElement = findFormField(snapshot, checkbox);
  const clickAction = buildFillAction(checkbox, checkboxElement, { status: "matched", value: "yes", checked: true });
  assert.equal(clickAction.action, "click");
  assert.equal(verifyFilledValue({ ...checkboxElement, checked: true }, checkbox, { status: "matched", checked: true, value: "yes" }).ok, true);

  const selectField = fields.find((field) => field.kind === "select");
  const selectElement = findFormField(snapshot, selectField);
  const selectAction = buildFillAction(selectField, selectElement, { status: "matched", value: "CSE", matchedOption: "CSE" });
  assert.equal(selectAction.action, "select");
  assert.equal(verifyFilledValue({ ...selectElement, selected: "CSE", value: "CSE" }, selectField, { status: "matched", value: "CSE", matchedOption: "CSE" }).ok, true);
});

test("dynamic form merge keeps completed answers and picks up newly revealed fields", () => {
  const snapshot = googleFormsLikeSnapshot();
  const initial = collectFormFields(snapshot);
  const session = {
    tabId: 1,
    goal: "fill this form",
    fields: initial.fields,
    index: 0,
    completed: new Set([initial.fields[0].fingerprint]),
    answers: new Map([[initial.fields[0].fingerprint, "Asha"]]),
    skippedManualCount: initial.manualFields.length,
    plannerMode: "heuristic",
    awaitingSubmitApproval: false,
  };

  const withCity = {
    ...snapshot,
    interactiveElements: [
      ...snapshot.interactiveElements,
      {
        id: 20, tag: "input", role: "textbox", label: "Which city can you relocate to?", type: "text",
        question: "Which city can you relocate to?", controlKind: "text", interactable: true, visible: true, isSensitive: false, value: "",
      },
    ],
  };
  const refreshed = collectFormFields(withCity);
  const merged = mergeFormSessionFields(session, refreshed);
  assert.equal(merged.completed.has(initial.fields[0].fingerprint), true);
  assert.ok(merged.fields.some((field) => /city/i.test(field.question)));
  assert.equal(merged.fields.some((field) => field.fingerprint === initial.fields[0].fingerprint), false);
});

test("sensitive password fields stay manual and never produce type actions through collector", () => {
  const { fields, manualFields } = collectFormFields(googleFormsLikeSnapshot());
  assert.ok(manualFields.some((field) => /password/i.test(field.label)));
  assert.equal(fields.some((field) => field.controlKind === "password"), false);
  const safety = inspectActionSafety(
    { action: "type", id: 11, text: "secret" },
    googleFormsLikeSnapshot(),
  );
  assert.equal(safety.permitted, false);
});

test("submit remains confirmation-gated and is never part of auto fill plan", () => {
  const snapshot = googleFormsLikeSnapshot();
  const { fields } = collectFormFields(snapshot);
  assert.equal(fields.some((field) => /submit/i.test(field.label)), false);
  const safety = inspectActionSafety({ action: "click", id: 12 }, snapshot);
  assert.equal(safety.requiresConfirmation, true);
});

test("understandFormFields falls back to heuristic mode without an API key", async () => {
  const { fields } = collectFormFields(googleFormsLikeSnapshot());
  const result = await understandFormFields(
    { provider: "gemini", apiKey: "" },
    fields,
    { languageCode: "en-IN", pageTitle: "Internship", pageSummary: "Apply" },
  );
  assert.equal(result.mode, "heuristic");
  assert.ok(result.fields[0].askPrompt);
});

test("mock planner mode is transparent and createPlanner does not pretend to be an LLM", () => {
  const explicit = resolvePlanner({ provider: "mock" });
  assert.equal(explicit.mode, "mock");
  assert.equal(explicit.degraded, false);
  assert.equal(explicit.planner.isMock, true);

  const degraded = resolvePlanner({ provider: "gemini", apiKey: "" });
  assert.equal(degraded.mode, "mock");
  assert.equal(degraded.degraded, true);
  assert.match(degraded.reason || "", /not intelligent LLM planning/i);

  assert.throws(
    () => resolvePlanner({ provider: "openai-compatible", apiKey: "" }, { allowSilentMock: false }),
    /API key/i,
  );

  const planner = createPlanner({ provider: "huggingface" });
  assert.equal(planner.id, "mock");

  const described = describePlannerMode({ provider: "gemini", apiKey: "" });
  assert.equal(described.mode, "mock");
  assert.equal(described.degraded, true);
  assert.match(described.label, /Mock fallback/i);
});

test("mock planner ask_user discloses offline mode instead of fake electricity options on unknown pages", async () => {
  const planner = createPlanner({ provider: "mock" });
  const action = await planner.plan({
    userRequest: "help me with this page",
    snapshot: {
      url: "https://example.test/unknown",
      title: "Unknown",
      summary: "A random page",
      timestamp: Date.now(),
      interactiveElements: [{ id: 1, tag: "button", role: "button", label: "Continue", isSensitive: false }],
    },
    history: [{ stepNumber: 1, action: { action: "click", id: 1 }, status: "success", timestamp: Date.now() }],
  });
  assert.equal(action.action, "ask_user");
  assert.match(action.question, /offline mock planner/i);
  assert.doesNotMatch(action.question, /electricity bill/i);
});

test("observer and executor source include custom control + verification support", async () => {
  const observer = await readFile(new URL("../content/observer.ts", import.meta.url), "utf8");
  const executor = await readFile(new URL("../content/executor.ts", import.meta.url), "utf8");
  const index = await readFile(new URL("../content/index.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../sidepanel/App.tsx", import.meta.url), "utf8");

  assert.match(observer, /role='textbox'/);
  assert.match(observer, /role='listbox'/);
  assert.match(observer, /contenteditable/);
  assert.match(observer, /nearbyQuestionText/);
  assert.match(observer, /readElementState/);

  assert.match(executor, /selectCustomOption/);
  assert.match(executor, /verifyActionResult/);
  assert.match(executor, /contentEditable|isContentEditable/);
  assert.match(executor, /verified/);

  assert.match(index, /BV_READ_ELEMENT_STATE/);
  assert.match(app, /understandFormFields/);
  assert.match(app, /verifyFilledValue/);
  assert.match(app, /describePlannerMode/);
  assert.doesNotMatch(app, /What should I enter for “%s”\?/);
});

test("Google Forms–like fixture page exists with ARIA radios, checkboxes, and combobox", async () => {
  const html = await readFile(new URL("./fixtures/google-forms-like.html", import.meta.url), "utf8");
  assert.match(html, /role="radio"/);
  assert.match(html, /role="checkbox"/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /role="listbox"/);
  assert.match(html, /Are you willing to relocate/);
  assert.match(html, /city-question/);
  assert.match(html, /type="password"/);
});

test("DOM change between observation and execution is detected when element ids no longer match", () => {
  const snapshot = googleFormsLikeSnapshot();
  const { fields } = collectFormFields(snapshot);
  const nameField = fields.find((field) => /full name/i.test(field.question));
  const staleSnapshot = {
    ...snapshot,
    interactiveElements: snapshot.interactiveElements.filter((element) => element.id !== 1),
  };
  const missing = findFormField(staleSnapshot, nameField);
  assert.equal(missing, undefined);
  const verification = verifyFilledValue(undefined, nameField, { status: "matched", value: "Asha" });
  assert.equal(verification.ok, false);
  assert.match(verification.reason || "", /not found/i);
});

test("failed interaction verification reports mismatch for custom dropdowns", () => {
  const snapshot = googleFormsLikeSnapshot();
  const { fields } = collectFormFields(snapshot);
  const language = fields.find((field) => field.kind === "combobox");
  const element = findFormField(snapshot, language);
  const failed = verifyFilledValue(
    { ...element, value: "Java", selected: "Java" },
    language,
    { status: "matched", value: "Python", matchedOption: "Python" },
  );
  assert.equal(failed.ok, false);
  assert.match(failed.reason || "", /dropdown|match/i);
});
