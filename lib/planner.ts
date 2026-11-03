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
import type { PageSnapshot, InteractiveElement } from "./safety.ts";

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
  pendingConfirmation?: boolean;
}

export interface PlannerProvider {
  readonly id: string;
  readonly name: string;
  plan(request: PlannerRequest): Promise<PlannerAction>;
}

export interface LLMConfig {
  provider: "openai-compatible" | "gemini" | "mock";
  endpoint?: string; // e.g. https://api.openai.com/v1 or https://openrouter.ai/api/v1
  apiKey?: string;
  model?: string; // e.g. gemini-3.8-flash, gpt-4o-mini, deepseek-chat
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
   - {"action": "ask_user", "question": "<question in user's language>", "options": ["opt1", "opt2"], "rationale": "<short rationale>"}
   - {"action": "done", "summary": "<concise summary of completed work>"}

2. Use ONLY element IDs listed in the snapshot's interactiveElements. Never invent IDs.
3. NEVER type into sensitive fields (passwords, OTPs, CVVs, Aadhaar). If a sensitive field is required, ask the user to fill it manually using ask_user.
4. Keep the rationale short (1 short sentence) in Hindi or Hinglish so it can be spoken via Text-to-Speech.
5. If the user's goal is accomplished on the current screen, return action "done".
6. Output raw JSON only with NO markdown wrappers or extra commentary.`;

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

    const promptText = buildPlannerPrompt(request);

    const messages = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: promptText },
    ];

    const bodyPayload = {
      model: this.model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
    };

    const response = await fetch(`${this.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(bodyPayload),
    });

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
      return this.retryCorrection(content, validation.error);
    }

    return validation.action;
  }

  private async retryCorrection(invalidRaw: string, errorMsg: string): Promise<PlannerAction> {
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
        response_format: { type: "json_object" },
      }),
    });

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const result = parseAndValidatePlannerJson(content);

    if (!result.valid) {
      throw new Error(`Planner LLM failed schema validation twice: ${result.error}`);
    }

    return result.action;
  }
}

/**
 * Shared helper to format the planner prompt into structured JSON context.
 */
export function buildPlannerPrompt(request: PlannerRequest): string {
  const recentHistory = (request.history || []).slice(-5).map((step) => ({
    stepNumber: step.stepNumber,
    action: step.action,
    status: step.status,
  }));

  return JSON.stringify(
    {
      userRequest: request.userRequest,
      pendingConfirmation: Boolean(request.pendingConfirmation),
      page: {
        url: request.snapshot.url,
        title: request.snapshot.title,
        summary: request.snapshot.summary,
        interactiveElements: request.snapshot.interactiveElements.map((el) => ({
          id: el.id,
          role: el.role,
          label: el.label,
          type: el.type,
          value: el.value,
          isSensitive: el.isSensitive,
        })),
      },
      last5Steps: recentHistory,
    },
    null,
    2
  );
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
      return this.retryCorrection(content, validation.error);
    }

    return validation.action;
  }

  private async retryCorrection(invalidRaw: string, errorMsg: string): Promise<PlannerAction> {
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

    return result.action;
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
    const req = request.userRequest.toLowerCase();
    const elements = request.snapshot.interactiveElements;
    const history = request.history || [];

    // 1. Explicit Confirmation Step: "ha", "yes", "confirm payment"
    if (
      (req.includes("ha") || req.includes("haan") || req.includes("yes") || req.includes("confirm")) &&
      (req.includes("confirm") || req.includes("payment") || req.includes("bharo") || req.includes("pay"))
    ) {
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
          rationale: "पुष्टि प्राप्त हुई। ₹1,450 का भुगतान सबमिट किया जा रहा है।",
        };
      }
    }

    // 2. Already on receipt / confirmation page
    if (
      request.snapshot.summary.toLowerCase().includes("success") ||
      request.snapshot.summary.toLowerCase().includes("सफल") ||
      request.snapshot.summary.toLowerCase().includes("receipt")
    ) {
      return {
        action: "done",
        summary: "बिजली बिल का भुगतान सफलतापूर्वक पूरा हो गया है। रसीद नंबर स्क्रीन पर उपलब्ध है।",
        rationale: "भुगतान सफल हुआ।",
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
        summary: "आपका बिजली बिल ₹1,450 है, देय तिथि 15 नवंबर 2026 है।",
        rationale: "बिल का विवरण स्क्रीन पर दिखाई दे रहा है।",
      };
    }

    // 4. Pay / Proceed to Payment Intent ("bill bharo", "pay electricity bill", "proceed to payment")
    const isPayOrProceed =
      req.includes("bharo") ||
      req.includes("pay") ||
      req.includes("chukaao") ||
      req.includes("proceed") ||
      req.includes("payment");

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
          rationale: "भुगतान के लिए आगे बढ़ा जा रहा है।",
        };
      }
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
        rationale: `कंज्यूमर नंबर ${consumerNumber} दर्ज किया जा रहा है।`,
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
        rationale: "बिल देखने के लिए बटन दबाया जा रहा है।",
      };
    }

    // 5. Default fallback to click first relevant action or ask user
    const firstClickable = elements.find((el) => el.tag === "button" || el.role === "button");
    if (firstClickable && history.length === 0) {
      return {
        action: "click",
        id: firstClickable.id,
        rationale: `'${firstClickable.label}' पर क्लिक किया जा रहा है।`,
      };
    }

    return {
      action: "ask_user",
      question: "आप क्या करना चाहते हैं? उदाहरण: 'बिजली बिल देखो' या 'बिल भरो'।",
      options: ["बिजली बिल देखो", "कंज्यूमर नंबर 100234567 भरो", "बिल भुगतान करो"],
      rationale: "उपयोगकर्ता से निर्देश माँगे जा रहे हैं।",
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
