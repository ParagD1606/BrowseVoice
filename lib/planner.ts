/**
 * Planner LLM Provider Interface and Implementations for Browse Voice.
 *
 * Requirements:
 * - Placed behind a provider interface (planner.ts) so models can be swapped.
 * - Receives: user request, page snapshot, last 5 steps.
 * - Returns ONE action as strict JSON validated against schema.ts.
 */

import {
  parseAndValidatePlannerJson,
  type PlannerAction,
} from "./schema.ts";
import type { PageSnapshot } from "./safety.ts";
import { hasPaymentReceipt, hasVisiblePaymentForm, isPaymentIntent } from "./payment-state.ts";
import {
  extractExactValueCandidates,
  contextFromElement,
  preserveExactPlannerValue,
  resolveFormValue,
} from "./form-values.ts";
import { cleanSnippetLines, cleanSnippetText } from "./snips.ts";

export interface StepLogEntry {
  stepNumber: number;
  action: PlannerAction;
  status: "success" | "blocked" | "failed" | "confirmation_required";
  spokenSummary?: string;
  details?: string;
  timestamp: number;
}

export interface PlannerRequest {
  userRequest: string;
  snapshot: PageSnapshot;
  history: StepLogEntry[]; // last 5 steps
  conversation?: Array<{ role: "user" | "assistant"; content: string }>;
  sharedMemoryContext?: string;
  pendingConfirmation?: boolean;
}

export interface PlannerProvider {
  readonly id: string;
  readonly name: string;
  plan(request: PlannerRequest): Promise<PlannerAction>;
}

/**
 * Applies a deterministic exact-value guard after any model has planned an
 * action. The model can identify the field and intent, but it is never allowed
 * to rewrite a value that the user supplied.
 */
export function protectPlannerAction(request: PlannerRequest, action: PlannerAction): PlannerAction {
  if (action.action !== "type") return action;
  const target = request.snapshot.interactiveElements.find((element) => element.id === action.id);
  const latestUserTurn = [...(request.conversation || [])].reverse().find((turn) => turn.role === "user")?.content;
  const sourceText = latestUserTurn && latestUserTurn !== request.userRequest
    ? `${request.userRequest}\n${latestUserTurn}`
    : request.userRequest;
  const protectedAction = preserveExactPlannerValue(action, sourceText, target);
  return protectedAction as PlannerAction;
}

export interface LLMConfig {
  provider: "openai-compatible" | "gemini" | "mock";
  endpoint?: string; // e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1
  apiKey?: string;
  model?: string; // e.g. gemini-3.8-flash, gpt-4o-mini, deepseek-chat
}

/** Convert a Hindi form answer to English text while preserving the user's facts. */
export async function convertFormAnswerToEnglish(
  config: LLMConfig,
  answer: string,
  mode: "translate" | "transliterate" | "date",
): Promise<string> {
  const instruction = mode === "transliterate"
    ? "Transliterate the Hindi personal name into commonly used English letters. Do not translate its meaning or add anything."
    : mode === "date"
      ? "Convert the Hindi date to YYYY-MM-DD. If the date is ambiguous, return the original answer unchanged. Return only the date."
      : "Translate the Hindi answer into concise natural English. Preserve names, numbers, dates, identifiers, and factual meaning. Do not infer missing information or add anything.";
  const prompt = `${instruction}\nReturn only the converted text.\n\nHindi answer: ${answer}`;

  if (!config.apiKey || config.provider === "mock") {
    throw new Error("Hindi-to-English conversion needs a configured Gemini or OpenAI-compatible model.");
  }

  if (config.provider === "gemini") {
    const model = config.model || "gemini-3.8-flash";
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are a precise Hindi-to-English form assistant. Never change factual details." }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 128 },
      }),
    });
    if (!response.ok) throw new Error(`Gemini conversion failed (${response.status}).`);
    const data = await response.json();
    const converted = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!converted) throw new Error("The model returned no converted text.");
    return converted;
  }

  const endpoint = (config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a precise Hindi-to-English form assistant. Never change factual details." },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 128,
    }),
  });
  if (!response.ok) throw new Error(`LLM conversion failed (${response.status}).`);
  const data = await response.json();
  const converted = data?.choices?.[0]?.message?.content?.trim();
  if (!converted || typeof converted !== "string") throw new Error("The model returned no converted text.");
  return converted;
}

export interface SnipContext {
  id: string;
  imageDataUrl: string;
  text: string;
  elements: string[];
  title: string;
  url: string;
}

export interface SnipAnswer {
  text: string;
  provider: string;
}

const SNIP_ANSWER_SYSTEM_PROMPT = `You are Browse Voice, a helpful visual browser assistant. Answer the user's question using the selected browser snippets as the primary source. Each snippet includes a screenshot and may include extracted page text and element labels. Be concise, accurate, and say when the selected area does not contain enough information. Do not claim to have read anything outside the snippets. Answer in the user's language or Hinglish when appropriate.`;

function buildSnipContextText(question: string, snips: SnipContext[]): string {
  const context = snips.map((snip, index) => ({
    snippet: index + 1,
    pageTitle: snip.title,
    pageUrl: snip.url,
    extractedText: cleanSnippetText(snip.text),
    visibleElements: snip.elements.map((element) => cleanSnippetText(element)).filter(Boolean),
  }));
  return `Question: ${question}\n\nSelected browser snippets:\n${JSON.stringify(context, null, 2)}`;
}

function dataUrlParts(dataUrl: string): { mimeType: string; data: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  return { mimeType: match?.[1] || "image/png", data: match?.[2] || dataUrl };
}

/** Answers a follow-up question using the screenshots and DOM context selected by the user. */
export async function answerAboutSnips(config: LLMConfig, question: string, snips: SnipContext[]): Promise<SnipAnswer> {
  if (config.provider === "gemini" && config.apiKey) {
    const model = config.model || "gemini-3.8-flash";
    const parts: Array<Record<string, unknown>> = [{ text: buildSnipContextText(question, snips) }];
    for (const snip of snips.slice(-4)) {
      const image = dataUrlParts(snip.imageDataUrl);
      parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
    }
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SNIP_ANSWER_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2 },
      }),
    });
    if (!response.ok) throw new Error(`Gemini vision API returned ${response.status}: ${await response.text()}`);
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
    if (!text) throw new Error("Gemini returned an empty answer.");
    return { text, provider: `Gemini (${model})` };
  }

  if (config.provider === "openai-compatible" && config.apiKey) {
    const endpoint = (config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
    const content: Array<Record<string, unknown>> = [{ type: "text", text: buildSnipContextText(question, snips) }];
    for (const snip of snips.slice(-4)) {
      content.push({ type: "image_url", image_url: { url: snip.imageDataUrl, detail: "high" } });
    }
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model || "gpt-4o-mini",
        messages: [
          { role: "system", content: SNIP_ANSWER_SYSTEM_PROMPT },
          { role: "user", content },
        ],
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      // Some OpenAI-compatible providers (including non-vision Groq models) only
      // accept string content. Keep the selected DOM context useful instead of
      // surfacing a raw 400 error in the conversation.
      if (/content must be a string|content.*string/i.test(errorText)) {
        const textOnlyResponse = await fetch(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({
            model: config.model || "gpt-4o-mini",
            messages: [
              { role: "system", content: `${SNIP_ANSWER_SYSTEM_PROMPT} The current model cannot inspect images, so answer only from the extracted text and element labels.` },
              { role: "user", content: buildSnipContextText(question, snips) },
            ],
            temperature: 0.2,
          }),
        });
        if (textOnlyResponse.ok) {
          const fallbackData = await textOnlyResponse.json();
          const fallbackText = fallbackData?.choices?.[0]?.message?.content?.trim();
          if (fallbackText) return { text: fallbackText, provider: `Text context (${config.model || "OpenAI-compatible"})` };
        }
        const extracted = snips.map((snip) => cleanSnippetText(snip.text)).filter(Boolean).join(" ");
        return {
          text: extracted ? `This model cannot read the image, but I found: ${extracted.slice(0, 700)}` : "This model does not support image questions. Choose Gemini or a vision-capable model in Settings.",
          provider: "Text context fallback",
        };
      }
      throw new Error(`Vision API returned ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Vision model returned an empty answer.");
    return { text, provider: `Vision (${config.model || "gpt-4o-mini"})` };
  }

  const extracted = snips.map((snip) => cleanSnippetLines([snip.text])).filter(Boolean).join(" ");
  return {
    text: extracted ? `I found this in the selected area: ${extracted.slice(0, 700)}` : "I have the selected area, but the offline planner cannot read its visual details. Add a Gemini or vision-capable model in Settings.",
    provider: "Offline preview",
  };
}

/**
 * System prompt instructing the Planner LLM to return strict JSON actions.
 */
export const PLANNER_SYSTEM_PROMPT = `You are "Browse Voice", an intelligent voice-controlled browser agent for Indian-language users (Hindi, Hinglish, English).
Your goal is to inspect the page snapshot and choose the SINGLE NEXT BEST ACTION to advance the user's task.

RULES:
1. Return ONLY valid JSON adhering strictly to ONE of the allowed action schemas:
   - {"action": "click", "id": <number>, "rationale": "<short rationale>"}
   - {"action": "type", "id": <number>, "text": "<value>", "rationale": "<short rationale>"}
   - {"action": "select", "id": <number>, "value": "<option>", "rationale": "<short rationale>"}
   - {"action": "scroll", "direction": "up"|"down"|"left"|"right", "amount": 300, "rationale": "<short rationale>"}
   - {"action": "navigate", "url": "<valid url>", "rationale": "<short rationale>"}
   - {"action": "open_tab", "url": "<valid url>", "task": "<optional task for the new tab>", "rationale": "<short rationale>"}
   - {"action": "ask_user", "question": "<question in user's language>", "options": ["opt1", "opt2"], "rationale": "<short rationale>"}
   - {"action": "done", "summary": "<concise summary of completed work>"}

2. Use ONLY element IDs listed in the snapshot's interactiveElements. Never invent IDs.
3. NEVER type into sensitive fields (passwords, OTPs, CVVs, Aadhaar). If a sensitive field is required, ask the user to fill it manually using ask_user.
4. Keep the rationale short (1 short sentence) in Hindi or Hinglish so it can be spoken via Text-to-Speech.
5. If the user's goal is accomplished on the current screen, return action "done".
   For payment tasks, NEVER claim payment is complete unless the currently visible page shows a successful payment receipt with a transaction ID. A payment form or a "continue to payment" page is not completion.
   Never click, read, or fill card, CVV, OTP, password, or other sensitive payment fields. Ask the user to handle those fields manually.
6. Treat values as data, not prose. For email addresses, UPI IDs, URLs/domains, phone numbers, OTPs, account references, usernames, passwords, API keys, codes, and other technical identifiers, copy every character exactly as supplied. Never translate, transliterate, normalize case, replace punctuation, or spell out these values.
7. Use the target field's label, name, type, autocomplete, placeholder, and role to decide whether it expects an exact identifier. Keep ordinary Hindi/Marathi/English sentences natural in regular text fields.
8. If an exact identifier field is requested but the exact identifier is not present or is only a phonetic/non-Latin transcription, return ask_user asking the user to repeat or confirm the exact value. Never guess.
9. Use open_tab when an independent source or subtask should be researched in a separate browser tab; include the URL and a concise task for its worker.
10. Output raw JSON only with NO markdown wrappers or extra commentary.`;

/**
 * LLM Provider communicating with OpenAI / OpenRouter / DeepSeek / Groq compatible APIs.
 */
export class OpenAICompatiblePlanner implements PlannerProvider {
  readonly id = "openai-compatible";
  readonly name: string;
  private endpoint: string;
  private apiKey: string;
  private model: string;

  constructor(config: LLMConfig) {
    this.endpoint = (config.endpoint || "https://api.openai.com/v1").replace(/\/$/, "");
    this.apiKey = config.apiKey || "";
    this.model = config.model || "gpt-4o-mini";
    this.name = `OpenAI Compatible (${this.model})`;
  }

  public async plan(request: PlannerRequest): Promise<PlannerAction> {
    if (!this.apiKey) {
      throw new Error("LLM API Key is missing. Please set it in Browse Voice Settings.");
    }

    const sendPrompt = (prompt: string) => fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
        // Planner responses are short JSON actions. Avoid reserving the provider's
        // default completion budget against a limited per-minute token allowance.
        max_tokens: 512,
        response_format: { type: "json_object" },
      }),
    });

    let response = await sendPrompt(buildPlannerPrompt(request));
    if (response.status === 413) {
      // Retry once with a smaller page slice if the provider rejected the first
      // request for size/TPM. Element IDs still refer to the same fresh snapshot.
      response = await sendPrompt(buildPlannerPrompt(request, { maxElements: 8, maxSummaryLength: 80 }));
    }

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      throw new Error("LLM returned empty or malformed completion.");
    }

    const validation = parseAndValidatePlannerJson(content);
    if (!validation.valid) {
      // Retry turn with correction prompt
      return this.retryCorrection(content, validation.error, request);
    }

    return protectPlannerAction(request, validation.action);
  }

  private async retryCorrection(invalidRaw: string, errorMsg: string, request?: PlannerRequest): Promise<PlannerAction> {
    const correctionMessages = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Your previous response was invalid JSON or violated schema: "${errorMsg}".\nPrevious response: ${invalidRaw}\nPlease correct it and return ONLY valid JSON.`,
      },
    ];

    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: correctionMessages,
        temperature: 0.0,
        max_tokens: 512,
        response_format: { type: "json_object" },
      }),
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const result = parseAndValidatePlannerJson(content);

    if (!result.valid) {
      throw new Error(`Planner LLM failed schema validation twice: ${result.error}`);
    }

    return request ? protectPlannerAction(request, result.action) : result.action;
  }
}

/**
 * Shared helper to format the planner prompt into structured JSON context.
 */
export function buildPlannerPrompt(
  request: PlannerRequest,
  limits: { maxElements?: number; maxSummaryLength?: number } = {},
): string {
  const maxElements = limits.maxElements ?? 24;
  const maxSummaryLength = limits.maxSummaryLength ?? 240;
  const identifierHints = extractExactValueCandidates(request.userRequest).map((candidate) => ({
    value: candidate.value,
    kind: candidate.kind,
  }));
  const words = request.userRequest.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const taskTerms = new Set(words.filter((word) => !["the", "and", "for", "from", "with", "play", "video", "please", "करो", "करना"].includes(word)));
  const allElements = request.snapshot.interactiveElements;
  const rankedElements = allElements.map((element, order) => {
    const text = `${element.label} ${element.name || ""} ${element.placeholder || ""} ${element.role}`.toLowerCase();
    const matches = Array.from(taskTerms).reduce((count, term) => count + Number(text.includes(term)), 0);
    const isSearch = /search|query|find|खोज/i.test(text) || element.type === "search";
    const isResult = /video|watch|play|music|song|clip/i.test(text);
    return { element, order, score: matches * 10 + Number(isSearch && /search|find|play|video|music/i.test(request.userRequest)) * 8 + Number(isResult) * 3 };
  });
  const selectedElements = rankedElements
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, maxElements)
    .sort((a, b) => a.order - b.order)
    .map(({ element: el }) => ({
      id: el.id,
      role: el.role.slice(0, 24),
      label: el.label.slice(0, 90),
      type: el.type,
      name: el.name,
      placeholder: el.placeholder,
      autocomplete: el.autocomplete,
      inputMode: el.inputMode,
      value: (el.value || "").slice(0, 80),
      isSensitive: el.isSensitive,
    }));

  const recentHistory = (request.history || []).slice(-5).map((step) => ({
    stepNumber: step.stepNumber,
    action: step.action.action,
    status: step.status,
    rationale: step.action.rationale?.slice(0, 80),
  }));

  return JSON.stringify({
    userRequest: request.userRequest.slice(0, 500),
      exactIdentifierHints: identifierHints,
      recentConversation: (request.conversation || []).slice(-6).map((turn) => ({
        role: turn.role,
        content: turn.content.slice(0, 180),
      })),
    sharedMemory: request.sharedMemoryContext?.slice(0, 14000),
    pendingConfirmation: Boolean(request.pendingConfirmation),
    page: {
      url: request.snapshot.url.slice(0, 300),
      title: request.snapshot.title.slice(0, 160),
      summary: request.snapshot.summary.slice(0, maxSummaryLength),
      interactiveElements: selectedElements,
      omittedInteractiveElementCount: Math.max(0, allElements.length - selectedElements.length),
    },
    last5Steps: recentHistory,
  });
}

/**
 * Google Gemini Planner Provider (using Google AI Studio API).
 * Endpoint: https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}
 */
export class GeminiPlanner implements PlannerProvider {
  readonly id = "gemini";
  readonly name: string;
  private apiKey: string;
  private model: string;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey || "";
    this.model = config.model || "gemini-3.8-flash";
    this.name = `Google Gemini (${this.model})`;
  }

  public async plan(request: PlannerRequest): Promise<PlannerAction> {
    if (!this.apiKey) {
      throw new Error("Google Gemini API Key is missing. Please set it in Browse Voice Settings or .env.");
    }

    const promptText = buildPlannerPrompt(request);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const bodyPayload = {
      systemInstruction: {
        parts: [{ text: PLANNER_SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: promptText }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bodyPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!content || typeof content !== "string") {
      throw new Error("Gemini returned empty or malformed completion.");
    }

    const validation = parseAndValidatePlannerJson(content);
    if (!validation.valid) {
      return this.retryCorrection(content, validation.error, request);
    }

    return protectPlannerAction(request, validation.action);
  }

  private async retryCorrection(invalidRaw: string, errorMsg: string, request?: PlannerRequest): Promise<PlannerAction> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const correctionText = `Your previous response was invalid JSON or violated schema: "${errorMsg}".\nPrevious response: ${invalidRaw}\nPlease correct it and return ONLY valid JSON.`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PLANNER_SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: correctionText }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    });

    const data = await response.json();
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const result = parseAndValidatePlannerJson(content);

    if (!result.valid) {
      throw new Error(`Gemini LLM failed schema validation twice: ${result.error}`);
    }

    return request ? protectPlannerAction(request, result.action) : result.action;
  }
}

/**
 * Deterministic Mock / Rule-Based Planner.
 * Enables zero-dependency testing and demonstration on the BijliSeva mock portal
 * even before the user supplies an external LLM API key.
 */
export class MockRuleBasedPlanner implements PlannerProvider {
  readonly id = "mock";
  readonly name = "Mock / Rule-Based Planner (Demo & Tests)";

  public async plan(request: PlannerRequest): Promise<PlannerAction> {
    const originalRequest = [...(request.conversation || [])]
      .reverse()
      .find((message) => message.role === "user")?.content || request.userRequest;
    const latestUserRequest = [...(request.conversation || [])]
      .reverse()
      .find((message) => message.role === "user")?.content || request.userRequest;
    const req = `${request.userRequest} ${latestUserRequest}`.toLowerCase();
    const elements = request.snapshot.interactiveElements;
    const history = request.history || [];

    // 1. Explicit Confirmation Step: "ha", "yes", "confirm payment"
    const latestUserExplicitlyConfirmed = /\b(?:yes|haan|ha|haa|confirm(?:ed)?|approve|proceed)\b|हाँ|हां|पुष्टि/i.test(latestUserRequest);
    if (latestUserExplicitlyConfirmed && isPaymentIntent(req)) {
      const payConfirmBtn = elements.find(
        (el) =>
          (el.tag === "button" || el.type === "submit") &&
          (el.label.toLowerCase().includes("pay ₹") ||
            el.label.toLowerCase().includes("भुगतान करें") ||
            el.label.toLowerCase().includes("confirm pay"))
      );

      if (payConfirmBtn) {
        return {
          action: "click",
          id: payConfirmBtn.id,
          rationale: "Confirmation received. Submitting the ₹1,450 payment.",
        };
      }
    }

    // 2. Already on receipt / confirmation page
    if (hasPaymentReceipt(request.snapshot.summary)) {
      return {
        action: "done",
        summary: "The electricity bill payment was completed successfully. The receipt is available on screen.",
        rationale: "Payment completed successfully.",
      };
    }

    // Do not treat opening the payment page as completing a payment. The user
    // must enter sensitive details themselves and explicitly request the final submit.
    const paySubmitButton = elements.find((el) =>
      (el.tag === "button" || el.role === "button" || el.type === "submit") &&
      /\bpay\b|भुगतान/i.test(el.label),
    );
    if (isPaymentIntent(req) && hasVisiblePaymentForm(request.snapshot) && paySubmitButton) {
      return {
        action: "ask_user",
        question: "भुगतान फ़ॉर्म खुला है। कार्ड, UPI या अन्य गोपनीय जानकारी आप स्वयं भरें। राशि जाँचने के बाद, अगर भुगतान करना चाहते हैं, तो कहें ‘भुगतान की पुष्टि करें’।",
        rationale: "गोपनीय भुगतान जानकारी आपको स्वयं भरनी होगी।",
      };
    }

    // 3. Bill details already visible and user just wants to see/view/check
    const billVisible =
      request.snapshot.summary.toLowerCase().includes("₹1,450") ||
      request.snapshot.summary.toLowerCase().includes("amount due") ||
      request.snapshot.summary.toLowerCase().includes("units consumed");

    if (billVisible && (req.includes("dekho") || req.includes("check") || req.includes("show") || req.includes("pending"))) {
      return {
        action: "done",
        summary: "Your electricity bill is ₹1,450, due on November 15, 2026.",
        rationale: "The bill details are visible on screen.",
      };
    }

    // 4. Pay / Proceed to Payment Intent ("bill bharo", "pay electricity bill", "proceed to payment")
    const isPayOrProceed = isPaymentIntent(req);

    if (isPayOrProceed) {
      const proceedBtn = elements.find(
        (el) =>
          (el.tag === "button" || el.role === "button") &&
          (el.label.toLowerCase().includes("proceed") ||
            el.label.toLowerCase().includes("pay") ||
            el.label.toLowerCase().includes("भरो") ||
            el.label.toLowerCase().includes("भुगतान"))
      );

      if (proceedBtn) {
        return {
          action: "click",
          id: proceedBtn.id,
          rationale: "Moving to payment.",
        };
      }
    }

    // Exact-value fields are resolved from the utterance and DOM context before
    // any generic command heuristics. This keeps the offline/demo planner safe
    // and gives it the same identifier behavior as the LLM planners.
    const exactField = elements.find((element) => {
      if (!(["input", "textarea"].includes(element.tag)) || element.isSensitive) return false;
      const decision = resolveFormValue(originalRequest, contextFromElement(element));
      const fieldTerms = `${element.label} ${element.name || ""} ${element.placeholder || ""}`
        .toLowerCase().match(/[a-z0-9]{3,}/g) || [];
      const fieldMentioned = fieldTerms.some((term) => originalRequest.toLowerCase().includes(term));
      return decision.requiresExactValue && (decision.exactValue !== undefined || (decision.ambiguous && fieldMentioned));
    });
    if (exactField) {
      const protectedAction = preserveExactPlannerValue(
        { action: "type", id: exactField.id, text: originalRequest },
        originalRequest,
        exactField,
      );
      return protectedAction as PlannerAction;
    }

    // 5. Consumer Number Typing Intent ("mera consumer number 100234567 daalo", "fill consumer number")
    const numMatch = req.match(/\b\d{6,12}\b/);
    const consumerInput = elements.find(
      (el) =>
        el.tag === "input" &&
        (el.name?.includes("consumer") ||
          el.id.toString() === "consumer-num" ||
          el.label.toLowerCase().includes("consumer") ||
          el.placeholder?.toLowerCase().includes("consumer"))
    );

    if (
      consumerInput &&
      (req.includes("consumer") || req.includes("number") || req.includes("daalo") || req.includes("fill") || req.includes("type") || !consumerInput.value)
    ) {
      const consumerNumber = numMatch ? numMatch[0] : "100234567";
      return {
        action: "type",
        id: consumerInput.id,
        text: consumerNumber,
        rationale: `Entering consumer number ${consumerNumber}.`,
      };
    }

    // 6. Check / View Bill Button ("bill check karo", "check bill")
    const checkBillBtn = elements.find(
      (el) =>
        (el.tag === "button" || el.role === "button") &&
        (el.label.toLowerCase().includes("check") ||
          el.label.toLowerCase().includes("view") ||
          el.label.toLowerCase().includes("dekho") ||
          el.label.toLowerCase().includes("खोजें") ||
          el.label.toLowerCase().includes("बिल देखें"))
    );

    if (checkBillBtn) {
      return {
        action: "click",
        id: checkBillBtn.id,
        rationale: "Clicking the bill button.",
      };
    }

    // 5. Default fallback to click first relevant action or ask user
    const firstClickable = elements.find((el) => el.tag === "button" || el.role === "button");
    if (firstClickable && history.length === 0) {
      return {
        action: "click",
        id: firstClickable.id,
        rationale: `Clicking '${firstClickable.label}'.`,
      };
    }

    return {
      action: "ask_user",
      question: "What would you like to do? For example: check the electricity bill or pay the bill.",
      options: ["Check the electricity bill", "Enter consumer number 100234567", "Pay the bill"],
      rationale: "Asking the user for instructions.",
    };
  }
}

/**
 * Factory creating the active planner provider based on configuration.
 * Supports: "gemini" (Google AI Studio), "openai-compatible", "mock".
 */
export function createPlanner(config: LLMConfig): PlannerProvider {
  if (config.provider === "gemini" && config.apiKey) {
    return new GeminiPlanner(config);
  }
  if (config.provider === "openai-compatible" && config.apiKey) {
    return new OpenAICompatiblePlanner(config);
  }
  return new MockRuleBasedPlanner();
}
