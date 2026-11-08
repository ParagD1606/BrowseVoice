/**
 * Universal form model for Browse Voice.
 *
 * Discovers fillable controls from page snapshots (native + custom ARIA),
 * understands what each field asks for, generates contextual questions,
 * resolves natural-language answers, and verifies fill outcomes.
 *
 * This module is intentionally website-agnostic: no Google Forms workflows
 * or hardcoded question meanings. Site quirks belong in observation heuristics.
 */

import type { LLMConfig } from "./planner.ts";
import type { FormControlKind, InteractiveElement, PageSnapshot } from "./safety.ts";
import type { PlannerAction } from "./schema.ts";

export type FormFieldKind = "text" | "select" | "checkbox" | "radio" | "combobox";

export interface FormFieldDescriptor {
  fingerprint: string;
  identity: string;
  occurrence: number;
  label: string;
  /** Best available question text (legend / nearby heading / label). */
  question: string;
  tag: string;
  type?: string;
  kind: FormFieldKind;
  controlKind: FormControlKind;
  name?: string;
  options?: string[];
  required?: boolean;
  /** Semantic intent inferred by LLM or local heuristics (never hardcoded answers). */
  semanticIntent?: string;
  /** Contextual question prepared for the user. */
  askPrompt?: string;
  /** Known answer already present in conversation/session context. */
  knownValue?: string;
  elementIds: number[];
}

export interface ManualFormField {
  id: number;
  label: string;
  reason: string;
  category?: string;
}

export interface FormCollectionResult {
  fields: FormFieldDescriptor[];
  manualFields: ManualFormField[];
}

export interface FormFillSession {
  tabId: number;
  goal: string;
  fields: FormFieldDescriptor[];
  index: number;
  completed: Set<string>;
  answers: Map<string, string>;
  skippedManualCount: number;
  plannerMode: "llm" | "heuristic";
  awaitingSubmitApproval: boolean;
}

export interface FormUnderstandingItem {
  fingerprint: string;
  question: string;
  fieldType: FormFieldKind;
  options?: string[];
  required?: boolean;
  semanticIntent?: string;
  userInformationAvailable: boolean;
  knownValue?: string;
  action: "ask_user" | "use_known" | "skip" | "manual";
  askPrompt?: string;
}

export interface AnswerResolution {
  status: "matched" | "ambiguous" | "invalid" | "sensitive" | "empty";
  value?: string;
  checked?: boolean;
  message?: string;
  matchedOption?: string;
}

export interface FillVerification {
  ok: boolean;
  expected: string;
  observed: string;
  reason?: string;
}

const FILLABLE_KINDS = new Set<FormControlKind>([
  "text",
  "email",
  "tel",
  "number",
  "date",
  "textarea",
  "select",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "contenteditable",
]);

const SKIP_NATIVE_TYPES = new Set(["button", "submit", "reset", "hidden", "image", "range", "color"]);

export function isFormFillIntent(goal: string): boolean {
  return /\b(fill|complete|populate|enter details|register|sign up|apply for|bhar(?:o|na|do|de))\b|फॉर्म|फ़ॉर्म|भर(?:ो|ना|ें)/i.test(goal);
}

export function toEnglishDigits(value: string): string {
  return value.replace(/[०-९]/g, (digit) => String("०१२३४५६७८९".indexOf(digit)));
}

export function parseYesNo(value: string): boolean | null {
  const answer = value.trim();
  if (!answer) return null;
  if (/^(yes|y|yeah|yep|haan|ha|haa|check|tick|true|ok|okay|sure)(?:\b|$)/i.test(answer) || /^(हाँ|हां|जी|हॉ)(?:\s|$|[,!.])/u.test(answer)) return true;
  if (/^(no|n|nope|nahin|nahi|leave unchecked|uncheck|false)(?:\b|$)/i.test(answer) || /^(नहीं|नहि|ना)(?:\s|$|[,!.])/u.test(answer)) return false;
  return null;
}

export function matchOption(options: string[], answer: string): string | undefined {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || options.length === 0) return undefined;

  const ordinal = new Map<string, number>([
    ["first", 0], ["1st", 0], ["पहला", 0], ["पहली", 0], ["एक", 0],
    ["second", 1], ["2nd", 1], ["दूसरा", 1], ["दूसरी", 1], ["दो", 1],
    ["third", 2], ["3rd", 2], ["तीसरा", 2], ["तीसरी", 2], ["तीन", 2],
    ["fourth", 3], ["4th", 3], ["चौथा", 3], ["चौथी", 3], ["चार", 3],
  ]).get(normalized);
  if (ordinal !== undefined && options[ordinal]) return options[ordinal];

  const numericIndex = /^\d+$/.test(normalized) ? Number(normalized) - 1 : -1;
  if (numericIndex >= 0 && options[numericIndex]) return options[numericIndex];

  const exact = options.find((option) => option.toLowerCase() === normalized);
  if (exact) return exact;

  const includes = options.filter((option) =>
    option.toLowerCase().includes(normalized) || normalized.includes(option.toLowerCase()),
  );
  if (includes.length === 1) return includes[0];

  const yesNo = parseYesNo(answer);
  if (yesNo !== null) {
    const yes = options.find((option) => /^(yes|y|haan|हाँ|हां)$/i.test(option.trim()));
    const no = options.find((option) => /^(no|n|nahi|नहीं)$/i.test(option.trim()));
    if (yesNo && yes) return yes;
    if (!yesNo && no) return no;
  }

  return undefined;
}

function normalizeLabel(value: string | undefined): string {
  return (value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function fieldKindFromElement(element: InteractiveElement): FormFieldKind | "file" | "password" | "skip" {
  const kind = element.controlKind;
  const type = (element.type || "").toLowerCase();
  if (kind === "file" || type === "file") return "file";
  if (kind === "password" || type === "password") return "password";
  if (kind === "checkbox" || type === "checkbox" || element.role === "checkbox") return "checkbox";
  if (kind === "radio" || type === "radio" || element.role === "radio") return "radio";
  if (kind === "select" || kind === "listbox" || element.tag === "select") return "select";
  if (kind === "combobox" || element.role === "combobox") return "combobox";
  if (FILLABLE_KINDS.has(kind || "other") || ["input", "textarea"].includes(element.tag) || element.contentEditable) {
    return "text";
  }
  if (SKIP_NATIVE_TYPES.has(type)) return "skip";
  return "skip";
}

function isFillableElement(element: InteractiveElement): boolean {
  if (element.visible === false) return false;
  if (element.disabled || element.readOnly) return false;
  const kind = fieldKindFromElement(element);
  if (kind === "skip") return false;
  if (element.tag === "button" || element.role === "button" || element.role === "link") {
    return element.controlKind === "checkbox"
      || element.controlKind === "radio"
      || element.controlKind === "combobox"
      || element.controlKind === "listbox"
      || element.role === "checkbox"
      || element.role === "radio"
      || element.role === "combobox"
      || element.role === "listbox";
  }
  return true;
}

function questionForElement(element: InteractiveElement): string {
  return normalizeLabel(element.question) || normalizeLabel(element.label) || normalizeLabel(element.placeholder) || normalizeLabel(element.name) || `${element.tag} field`;
}

function identityForElement(element: InteractiveElement, kind: FormFieldKind): string {
  if (kind === "radio") {
    return JSON.stringify(["radio", element.groupName || element.name || questionForElement(element)]);
  }
  if (kind === "checkbox") {
    return JSON.stringify(["checkbox", questionForElement(element), element.name || ""]);
  }
  return JSON.stringify([
    element.controlKind || element.tag,
    element.type || "",
    questionForElement(element),
    element.name || "",
    element.placeholder || "",
  ]);
}

/**
 * Collect fillable form fields from a page snapshot.
 * Supports native inputs and custom ARIA / React controls already observed.
 */
export function collectFormFields(snapshot: PageSnapshot): FormCollectionResult {
  const occurrenceByIdentity = new Map<string, number>();
  const manualFields: ManualFormField[] = [];
  const fields: FormFieldDescriptor[] = [];
  const radioGroups = new Map<string, FormFieldDescriptor>();

  for (const element of snapshot.interactiveElements) {
    if (!isFillableElement(element)) continue;
    const kind = fieldKindFromElement(element);
    if (kind === "skip") continue;

    const label = questionForElement(element);
    if (kind === "file" || kind === "password" || element.isSensitive) {
      manualFields.push({
        id: element.id,
        label: label || (kind === "file" ? "File upload" : "Sensitive field"),
        reason: kind === "file"
          ? "Choose this file yourself"
          : element.sensitiveReason || "Fill manually for your security",
        category: element.category,
      });
      continue;
    }

    if (kind === "radio") {
      const identity = identityForElement(element, "radio");
      const optionLabel = normalizeLabel(element.label) || label;
      const existing = radioGroups.get(identity);
      if (existing) {
        if (optionLabel && !existing.options?.includes(optionLabel)) existing.options = [...(existing.options || []), optionLabel];
        existing.elementIds.push(element.id);
        existing.required = existing.required || element.required;
      } else {
        const occurrence = occurrenceByIdentity.get(identity) || 0;
        occurrenceByIdentity.set(identity, occurrence + 1);
        const field: FormFieldDescriptor = {
          fingerprint: `${identity}#${occurrence}`,
          identity,
          occurrence,
          label: normalizeLabel(element.groupName || element.name) || label,
          question: normalizeLabel(element.question) || normalizeLabel(element.groupName || element.name) || label,
          tag: element.tag,
          type: element.type || "radio",
          kind: "radio",
          controlKind: element.controlKind || "radio",
          name: element.name || element.groupName,
          options: optionLabel ? [optionLabel] : [],
          required: element.required,
          elementIds: [element.id],
        };
        radioGroups.set(identity, field);
        fields.push(field);
      }
      continue;
    }

    const identity = identityForElement(element, kind);
    const occurrence = occurrenceByIdentity.get(identity) || 0;
    occurrenceByIdentity.set(identity, occurrence + 1);
    const options = element.options?.map(normalizeLabel).filter(Boolean);
    fields.push({
      fingerprint: `${identity}#${occurrence}`,
      identity,
      occurrence,
      label,
      question: questionForElement(element),
      tag: element.tag,
      type: element.type,
      kind,
      controlKind: element.controlKind || (kind === "text" ? "text" : kind === "combobox" ? "combobox" : kind === "select" ? "select" : kind === "checkbox" ? "checkbox" : "other"),
      name: element.name,
      options: kind === "select" || kind === "combobox" ? options : undefined,
      required: element.required,
      elementIds: [element.id],
      knownValue: element.value && element.value !== "[REDACTED_SENSITIVE]" ? element.value : undefined,
    });
  }

  return { fields, manualFields };
}

export function findFormField(
  snapshot: PageSnapshot,
  descriptor: FormFieldDescriptor,
  answer?: string,
): InteractiveElement | undefined {
  if (descriptor.kind === "radio") {
    const selectedLabel = matchOption(descriptor.options || [], answer || "");
    if (!selectedLabel) return undefined;
    return snapshot.interactiveElements.find((element) => {
      if (element.isSensitive) return false;
      const isRadio = element.controlKind === "radio" || element.type?.toLowerCase() === "radio" || element.role === "radio";
      if (!isRadio) return false;
      const sameGroup = (element.groupName || element.name || "") === (descriptor.name || "")
        || identityForElement(element, "radio") === descriptor.identity;
      return sameGroup && normalizeLabel(element.label).toLowerCase() === selectedLabel.toLowerCase();
    });
  }

  const matches = snapshot.interactiveElements.filter((element) => {
    if (element.isSensitive) return false;
    const kind = fieldKindFromElement(element);
    if (kind === "skip" || kind === "file" || kind === "password" || kind === "radio") return false;
    return identityForElement(element, kind) === descriptor.identity;
  });
  return matches[descriptor.occurrence] || matches.find((element) => descriptor.elementIds.includes(element.id));
}

/** Heuristic contextual question — used when LLM is unavailable (explicitly heuristic mode). */
export function buildHeuristicQuestion(field: FormFieldDescriptor, languageCode: string): string {
  const question = field.question || field.label;
  const options = (field.options || []).filter(Boolean);
  const lang = languageCode.startsWith("hi") ? "hi" : "en";

  if (field.kind === "checkbox") {
    return lang === "hi"
      ? `फॉर्म पूछता है: “${question}”. क्या मैं इसे चुनूँ? हाँ या नहीं बताइए।`
      : `The form asks: “${question}”. Should I check it? Please answer yes or no.`;
  }

  if ((field.kind === "select" || field.kind === "radio" || field.kind === "combobox") && options.length) {
    const listed = options.slice(0, 12).join(", ");
    return lang === "hi"
      ? `फॉर्म पूछता है: “${question}”. इनमें से क्या चुनूँ: ${listed}? विकल्प का नाम या नंबर बताइए।`
      : `The form asks: “${question}”. Which option should I choose: ${listed}? Say the option or its number.`;
  }

  if (/why|reason|motivate|describe|about yourself|cover letter|essay/i.test(question)) {
    return lang === "hi"
      ? `फॉर्म पूछता है: “${question}”. आप क्या लिखवाना चाहेंगे?`
      : `The form asks: “${question}”. What would you like me to enter?`;
  }

  return lang === "hi"
    ? `${question}?`
    : `${question}?`;
}

/**
 * Resolve a user's natural-language answer into a concrete form value.
 * Never invents personal data; asks for clarification on ambiguity.
 */
export function resolveFormAnswer(field: FormFieldDescriptor, rawAnswer: string): AnswerResolution {
  const value = toEnglishDigits(rawAnswer.trim());
  if (!value) return { status: "empty", message: `Please answer for: ${field.question || field.label}` };

  if (field.kind === "checkbox") {
    const choice = parseYesNo(value);
    if (choice === null) {
      return { status: "invalid", message: `Please answer yes or no for: ${field.question || field.label}.` };
    }
    return { status: "matched", value: choice ? "yes" : "no", checked: choice };
  }

  if (field.kind === "radio" || field.kind === "select" || field.kind === "combobox") {
    const options = field.options || [];
    if (options.length === 0) {
      return { status: "matched", value };
    }
    const match = matchOption(options, value);
    if (!match) {
      return {
        status: "ambiguous",
        message: `Choose one of these options for ${field.question || field.label}: ${options.join(", ")}`,
      };
    }
    return { status: "matched", value: match, matchedOption: match };
  }

  return { status: "matched", value };
}

export function buildFillAction(
  field: FormFieldDescriptor,
  element: InteractiveElement,
  resolution: AnswerResolution,
): PlannerAction | null {
  if (resolution.status !== "matched") return null;

  if (field.kind === "checkbox") {
    const desired = Boolean(resolution.checked);
    if (element.checked === desired) return null;
    return { action: "click", id: element.id, rationale: `${desired ? "Checked" : "Unchecked"} ${field.label}.` };
  }

  if (field.kind === "radio") {
    if (element.checked) return null;
    return { action: "click", id: element.id, rationale: `Selected ${resolution.value} for ${field.label}.` };
  }

  if (field.kind === "select") {
    return { action: "select", id: element.id, value: resolution.value || "" };
  }

  if (field.kind === "combobox") {
    // Prefer select when the observed control is a native select; otherwise type + click option flow.
    if (element.tag === "select") {
      return { action: "select", id: element.id, value: resolution.value || "" };
    }
    return { action: "select", id: element.id, value: resolution.value || "" };
  }

  return { action: "type", id: element.id, text: resolution.value || "" };
}

export function verifyFilledValue(
  element: InteractiveElement | undefined,
  field: FormFieldDescriptor,
  resolution: AnswerResolution,
): FillVerification {
  const expected = resolution.matchedOption || resolution.value || "";
  if (!element) {
    return { ok: false, expected, observed: "", reason: "Target element was not found after the action." };
  }

  if (field.kind === "checkbox") {
    const desired = Boolean(resolution.checked);
    const observed = element.checked ? "checked" : "unchecked";
    return {
      ok: element.checked === desired,
      expected: desired ? "checked" : "unchecked",
      observed,
      reason: element.checked === desired ? undefined : "Checkbox state did not match the requested answer.",
    };
  }

  if (field.kind === "radio") {
    const observed = element.checked ? (element.label || "selected") : "not selected";
    return {
      ok: Boolean(element.checked),
      expected,
      observed,
      reason: element.checked ? undefined : "Radio option was not selected.",
    };
  }

  if (field.kind === "select" || field.kind === "combobox") {
    const observed = normalizeLabel(element.selected || element.value);
    const ok = Boolean(
      observed
      && (observed.toLowerCase() === expected.toLowerCase()
        || observed.toLowerCase().includes(expected.toLowerCase())
        || expected.toLowerCase().includes(observed.toLowerCase())),
    );
    return {
      ok,
      expected,
      observed,
      reason: ok ? undefined : "Dropdown selection did not match the requested option.",
    };
  }

  const observed = normalizeLabel(element.value);
  const ok = observed.toLowerCase() === expected.toLowerCase()
    || observed.replace(/\s+/g, " ").toLowerCase() === expected.replace(/\s+/g, " ").toLowerCase();
  return {
    ok,
    expected,
    observed,
    reason: ok ? undefined : "Entered value did not stick in the field.",
  };
}

/** Merge newly revealed fields into an active session after DOM changes. */
export function mergeFormSessionFields(
  session: FormFillSession,
  collected: FormCollectionResult,
): FormFillSession {
  const remaining = collected.fields.filter((field) => !session.completed.has(field.fingerprint));
  return {
    ...session,
    fields: remaining,
    index: 0,
    skippedManualCount: Math.max(session.skippedManualCount, collected.manualFields.length),
  };
}

export function lookUpKnownAnswer(
  field: FormFieldDescriptor,
  answers: Map<string, string>,
  conversation: Array<{ role: string; content: string }> = [],
): string | undefined {
  const direct = answers.get(field.fingerprint) || answers.get(field.identity);
  if (direct) return direct;

  const intent = (field.semanticIntent || field.question || field.label).toLowerCase();
  for (const [key, value] of answers.entries()) {
    if (intent && key.toLowerCase().includes(intent.slice(0, 24))) return value;
  }

  // Lightweight reuse from prior user turns mentioning the same question keywords.
  const keywords = intent.split(/\s+/).filter((part) => part.length > 3).slice(0, 4);
  if (!keywords.length) return undefined;
  for (const turn of [...conversation].reverse()) {
    if (turn.role !== "user") continue;
    const content = turn.content.trim();
    if (content.length < 2 || content.length > 120) continue;
    if (keywords.some((word) => content.toLowerCase().includes(word))) continue;
  }
  return undefined;
}

function stripJsonFence(raw: string): string {
  let clean = raw.trim();
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return clean;
}

function parseJsonObject(raw: string): unknown {
  const clean = stripJsonFence(raw);
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(clean.slice(start, end + 1));
    throw new Error("Form understanding response was not valid JSON.");
  }
}

function applyUnderstanding(
  fields: FormFieldDescriptor[],
  items: FormUnderstandingItem[],
): FormFieldDescriptor[] {
  const byFingerprint = new Map(items.map((item) => [item.fingerprint, item]));
  return fields.map((field) => {
    const item = byFingerprint.get(field.fingerprint);
    if (!item) {
      return { ...field, askPrompt: field.askPrompt || buildHeuristicQuestion(field, "en-IN") };
    }
    return {
      ...field,
      question: item.question || field.question,
      semanticIntent: item.semanticIntent || field.semanticIntent,
      knownValue: item.knownValue || field.knownValue,
      askPrompt: item.askPrompt || buildHeuristicQuestion({ ...field, question: item.question || field.question }, "en-IN"),
      required: item.required ?? field.required,
      options: item.options?.length ? item.options : field.options,
    };
  }).filter((field) => {
    const item = byFingerprint.get(field.fingerprint);
    return !item || item.action !== "skip";
  });
}

/**
 * LLM-powered form understanding. Falls back to heuristics when the provider
 * is mock / missing / fails — callers must surface plannerMode accordingly.
 */
export async function understandFormFields(
  config: LLMConfig,
  fields: FormFieldDescriptor[],
  options: {
    languageCode: string;
    pageTitle?: string;
    pageSummary?: string;
    conversation?: Array<{ role: string; content: string }>;
    knownAnswers?: Map<string, string>;
  },
): Promise<{ fields: FormFieldDescriptor[]; mode: "llm" | "heuristic"; error?: string }> {
  const withLocalKnown = fields.map((field) => {
    const known = options.knownAnswers ? lookUpKnownAnswer(field, options.knownAnswers, options.conversation) : undefined;
    return {
      ...field,
      knownValue: known || field.knownValue,
      askPrompt: buildHeuristicQuestion(field, options.languageCode),
    };
  });

  if (!config.apiKey || config.provider === "mock" || fields.length === 0) {
    return { fields: withLocalKnown, mode: "heuristic" };
  }

  const compactFields = withLocalKnown.slice(0, 40).map((field) => ({
    fingerprint: field.fingerprint,
    question: field.question,
    label: field.label,
    fieldType: field.kind,
    options: field.options?.slice(0, 20),
    required: Boolean(field.required),
    knownValue: field.knownValue || null,
  }));

  const system = `You are Browse Voice's form understanding engine.
Read the observed form fields and conversation. For each field, decide what information is needed.
Never invent personal information. Never invent options that are not listed.
Return ONLY JSON:
{
  "fields": [
    {
      "fingerprint": "...",
      "question": "actual form question",
      "fieldType": "text|select|checkbox|radio|combobox",
      "options": ["..."],
      "required": true,
      "semanticIntent": "short_snake_case_intent",
      "userInformationAvailable": false,
      "knownValue": null,
      "action": "ask_user|use_known|skip|manual",
      "askPrompt": "one natural question in the user's language"
    }
  ]
}
askPrompt must sound like a helpful assistant sitting beside the user, based on the real form question — not a generic "what should I enter for this field" template.
Ask one field at a time readiness: askPrompt is for that single field.
Use the response language: ${options.languageCode}.`;

  const userPrompt = JSON.stringify({
    pageTitle: options.pageTitle || "",
    pageSummary: (options.pageSummary || "").slice(0, 500),
    conversation: (options.conversation || []).slice(-6),
    fields: compactFields,
  });

  try {
    const raw = await callFormUnderstandingModel(config, system, userPrompt);
    const parsed = parseJsonObject(raw) as { fields?: FormUnderstandingItem[] };
    if (!Array.isArray(parsed.fields)) {
      return { fields: withLocalKnown, mode: "heuristic", error: "Form understanding JSON missing fields array." };
    }
    const normalized: FormUnderstandingItem[] = parsed.fields
      .filter((item) => item && typeof item.fingerprint === "string")
      .map((item) => ({
        fingerprint: item.fingerprint,
        question: typeof item.question === "string" ? item.question : "",
        fieldType: item.fieldType,
        options: Array.isArray(item.options) ? item.options.filter((opt) => typeof opt === "string") : undefined,
        required: Boolean(item.required),
        semanticIntent: typeof item.semanticIntent === "string" ? item.semanticIntent : undefined,
        userInformationAvailable: Boolean(item.userInformationAvailable),
        knownValue: typeof item.knownValue === "string" ? item.knownValue : undefined,
        action: item.action === "use_known" || item.action === "skip" || item.action === "manual" ? item.action : "ask_user",
        askPrompt: typeof item.askPrompt === "string" ? item.askPrompt : undefined,
      }));
    return { fields: applyUnderstanding(withLocalKnown, normalized), mode: "llm" };
  } catch (error) {
    return {
      fields: withLocalKnown,
      mode: "heuristic",
      error: error instanceof Error ? error.message : "Form understanding failed.",
    };
  }
}

async function callFormUnderstandingModel(config: LLMConfig, system: string, userPrompt: string): Promise<string> {
  if (config.provider === "gemini") {
    const model = config.model || "gemini-3.8-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) throw new Error(`Gemini form understanding failed (${response.status}).`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini returned empty form understanding.");
    return text;
  }

  const endpoint = (config.provider === "huggingface"
    ? "https://router.huggingface.co/v1"
    : config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) throw new Error(`LLM form understanding failed (${response.status}).`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text || typeof text !== "string") throw new Error("LLM returned empty form understanding.");
  return text;
}

/**
 * Map a free-form answer onto listed options using the LLM when heuristics fail.
 * Still never invents an option outside the provided list.
 */
export async function resolveAmbiguousAnswerWithLLM(
  config: LLMConfig,
  field: FormFieldDescriptor,
  answer: string,
  languageCode: string,
): Promise<AnswerResolution> {
  const heuristic = resolveFormAnswer(field, answer);
  if (heuristic.status === "matched" || !field.options?.length) return heuristic;
  if (!config.apiKey || config.provider === "mock") return heuristic;

  try {
    const system = `Map the user's answer to exactly one option from the list. Return JSON {"match":"<option>"|null,"needsClarification":true|false,"message":"..."}. Never invent options. Language: ${languageCode}.`;
    const raw = await callFormUnderstandingModel(
      config,
      system,
      JSON.stringify({ question: field.question, options: field.options, answer }),
    );
    const parsed = parseJsonObject(raw) as { match?: string | null; needsClarification?: boolean; message?: string };
    if (typeof parsed.match === "string" && field.options.some((option) => option.toLowerCase() === parsed.match!.toLowerCase())) {
      const match = field.options.find((option) => option.toLowerCase() === parsed.match!.toLowerCase())!;
      return { status: "matched", value: match, matchedOption: match };
    }
    return {
      status: "ambiguous",
      message: parsed.message || heuristic.message,
    };
  } catch {
    return heuristic;
  }
}
