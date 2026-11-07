/**
 * Strict JSON schema and validation for Planner Actions in Browse Voice.
 *
 * Supported Actions:
 *  - click(id)
 *  - type(id, text)
 *  - select(id, value)
 *  - scroll(direction)
 *  - navigate(url)
 *  - ask_user(question)
 *  - done(summary)
 */

export type ActionType =
  | "click"
  | "type"
  | "select"
  | "scroll"
  | "navigate"
  | "ask_user"
  | "done";

export type ScrollDirection = "up" | "down" | "left" | "right";

export interface ClickAction {
  action: "click";
  id: number;
  rationale?: string;
}

export interface TypeAction {
  action: "type";
  id: number;
  text: string;
  rationale?: string;
}

export interface SelectAction {
  action: "select";
  id: number;
  value: string;
  rationale?: string;
}

export interface ScrollAction {
  action: "scroll";
  direction: ScrollDirection;
  amount?: number;
  rationale?: string;
}

export interface NavigateAction {
  action: "navigate";
  url: string;
  rationale?: string;
}

export interface AskUserAction {
  action: "ask_user";
  question: string;
  options?: string[];
  rationale?: string;
}

export interface DoneAction {
  action: "done";
  summary: string;
  rationale?: string;
}

export type PlannerAction =
  | ClickAction
  | TypeAction
  | SelectAction
  | ScrollAction
  | NavigateAction
  | AskUserAction
  | DoneAction;

export interface ValidationSuccess {
  valid: true;
  action: PlannerAction;
}

export interface ValidationFailure {
  valid: false;
  error: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

/** JSON Schema specification for the planner LLM system instructions */
export const PLANNER_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "PlannerAction",
  type: "object",
  required: ["action"],
  oneOf: [
    {
      properties: {
        action: { const: "click" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the interactive element to click" },
        rationale: { type: "string", description: "Short rationale in Hindi/Hinglish/English" },
      },
      required: ["action", "id"],
    },
    {
      properties: {
        action: { const: "type" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the input field" },
        text: { type: "string", description: "Text to type into the field" },
        rationale: { type: "string" },
      },
      required: ["action", "id", "text"],
    },
    {
      properties: {
        action: { const: "select" },
        id: { type: "integer", minimum: 1, description: "Numeric ID of the select/dropdown" },
        value: { type: "string", description: "Option value or label to choose" },
        rationale: { type: "string" },
      },
      required: ["action", "id", "value"],
    },
    {
      properties: {
        action: { const: "scroll" },
        direction: { enum: ["up", "down", "left", "right"] },
        amount: { type: "integer", minimum: 50 },
        rationale: { type: "string" },
      },
      required: ["action", "direction"],
    },
    {
      properties: {
        action: { const: "navigate" },
        url: { type: "string", format: "uri" },
        rationale: { type: "string" },
      },
      required: ["action", "url"],
    },
    {
      properties: {
        action: { const: "ask_user" },
        question: { type: "string", description: "Question to ask the user" },
        options: { type: "array", items: { type: "string" } },
        rationale: { type: "string" },
      },
      required: ["action", "question"],
    },
    {
      properties: {
        action: { const: "done" },
        summary: { type: "string", description: "Final concise summary of completed task" },
      },
      required: ["action", "summary"],
    },
  ],
};

/** Validates arbitrary input against the PlannerAction strict schema */
export function validatePlannerAction(input: unknown): ValidationResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Action output must be a non-null JSON object." };
  }

  const raw = input as Record<string, unknown>;
  const action = raw.action;

  if (typeof action !== "string") {
    return { valid: false, error: "Field 'action' is required and must be a string." };
  }

  const rationale = typeof raw.rationale === "string" ? raw.rationale : undefined;

  switch (action) {
    case "click": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'click' requires a positive integer 'id'." };
      }
      return { valid: true, action: { action: "click", id: raw.id, rationale } };
    }

    case "type": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'type' requires a positive integer 'id'." };
      }
      if (typeof raw.text !== "string") {
        return { valid: false, error: "action 'type' requires a string 'text'." };
      }
      return { valid: true, action: { action: "type", id: raw.id, text: raw.text, rationale } };
    }

    case "select": {
      if (typeof raw.id !== "number" || !Number.isInteger(raw.id) || raw.id <= 0) {
        return { valid: false, error: "action 'select' requires a positive integer 'id'." };
      }
      if (typeof raw.value !== "string" || raw.value.trim().length === 0) {
        return { valid: false, error: "action 'select' requires a non-empty string 'value'." };
      }
      return { valid: true, action: { action: "select", id: raw.id, value: raw.value, rationale } };
    }

    case "scroll": {
      const dir = raw.direction;
      if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") {
        return { valid: false, error: "action 'scroll' requires 'direction' of 'up' | 'down' | 'left' | 'right'." };
      }
      const amount = typeof raw.amount === "number" && raw.amount > 0 ? Math.round(raw.amount) : undefined;
      return { valid: true, action: { action: "scroll", direction: dir, amount, rationale } };
    }

    case "navigate": {
      if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
        return { valid: false, error: "action 'navigate' requires a non-empty string 'url'." };
      }
      return { valid: true, action: { action: "navigate", url: raw.url.trim(), rationale } };
    }

    case "ask_user": {
      if (typeof raw.question !== "string" || raw.question.trim().length === 0) {
        return { valid: false, error: "action 'ask_user' requires a non-empty string 'question'." };
      }
      const options = Array.isArray(raw.options) && raw.options.every((opt) => typeof opt === "string")
        ? (raw.options as string[])
        : undefined;
      return { valid: true, action: { action: "ask_user", question: raw.question.trim(), options, rationale } };
    }

    case "done": {
      if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) {
        return { valid: false, error: "action 'done' requires a non-empty string 'summary'." };
      }
      return { valid: true, action: { action: "done", summary: raw.summary.trim(), rationale } };
    }

    default:
      return {
        valid: false,
        error: `Unknown action '${String(action)}'. Allowed actions: click, type, select, scroll, navigate, ask_user, done.`,
      };
  }
}

/** Parses raw LLM text into a validated action, handling markdown code fences if present */
export function parseAndValidatePlannerJson(rawText: string): ValidationResult {
  let clean = rawText.trim();
  // Strip markdown code fences if LLM wrapped output in ```json ... ```
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // Attempt direct JSON parse or find surrounding curly braces
  try {
    const parsed = JSON.parse(clean);
    return validatePlannerAction(parsed);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(clean.slice(start, end + 1));
        return validatePlannerAction(parsed);
      } catch (innerErr) {
        return { valid: false, error: `JSON parse error: ${innerErr instanceof Error ? innerErr.message : "Malformed JSON"}` };
      }
    }
    return { valid: false, error: "LLM response did not contain a valid JSON object." };
  }
}
