export type GuidanceReason =
  | "sensitive_field"
  | "user_input_required"
  | "question"
  | "max_steps"
  | "repeated_action"
  | "no_progress"
  | "stale_element"
  | "action_failed"
  | "navigation_blocked"
  | "restricted_page"
  | "no_api_key"
  | "invalid_api_key"
  | "rate_limited"
  | "network_error"
  | "planner_error"
  | "mic_denied"
  | "tab_closed"
  | "load_timeout"
  | "payment_incomplete"
  | "stopped";

export interface GuidanceAction {
  label: string;
  kind: "resume" | "retry" | "continue_more" | "open_settings" | "open_url" | "focus_tab" | "dismiss";
  payload?: string;
}

export interface Guidance {
  reason: GuidanceReason;
  title: string;
  whatHappened: string;
  whatToDo: string[];
  actions: GuidanceAction[];
}

export interface GuidanceContext {
  languageCode?: string;
  translate?: (english: string, hindi: string) => string;
  taskLabel?: string;
  tabTitle?: string;
  fieldLabel?: string;
  fieldReason?: string;
  error?: string;
  retryAfterSeconds?: number;
  pageTitle?: string;
  pageSummary?: string;
  tried?: string[];
  completed?: string;
  remaining?: string;
  tabId?: number;
  fields?: Array<{ label: string; category?: string; description?: string }>;
  sectionTitle?: string;
}

function copy(context: GuidanceContext, english: string, hindi: string): string {
  if (context.translate) return context.translate(english, hindi);
  return context.languageCode?.toLowerCase().startsWith("hi") ? hindi : english;
}

function action(context: GuidanceContext, english: string, hindi: string, kind: GuidanceAction["kind"], payload?: string): GuidanceAction {
  return { label: copy(context, english, hindi), kind, ...(payload ? { payload } : {}) };
}

/** Builds short, actionable guidance for every terminal or waiting state. */
export function buildGuidance(reason: GuidanceReason, context: GuidanceContext = {}): Guidance {
  const task = context.taskLabel ? `${context.taskLabel}: ` : "";
  const title = (english: string, hindi: string) => copy(context, english, hindi);
  const line = (english: string, hindi: string) => copy(context, english, hindi);
  const commonRetry = [action(context, "Retry", "फिर कोशिश करें", "retry")];

  switch (reason) {
    case "user_input_required": {
      const fields = context.fields || [];
      const names = fields.map((field) => field.label).filter(Boolean).join(", ") || context.sectionTitle || "these private details";
      const details = fields.map((field) => field.description).filter(Boolean).join("; ");
      return {
        reason,
        title: title("This is a private step", "यह निजी जानकारी का चरण है"),
        whatHappened: line(`Please fill ${names} yourself${details ? ` (${details})` : ""}. I will not ask for it, type it, or read it.`, `कृपया ${names} स्वयं भरें${details ? ` (${details})` : ""}। मैं इसे नहीं पूछूँगा, टाइप करूँगा या पढ़ूँगा।`),
        whatToDo: [line("When you are done, say 'done' or tap Continue.", "भरने के बाद 'done' कहें या Continue दबाएँ।")],
        actions: [action(context, "Continue", "जारी रखें", "resume")],
      };
    }
    case "sensitive_field": {
      const field = context.fieldLabel || "the sensitive field";
      return {
        reason,
        title: title("Please fill this field yourself", "कृपया यह फ़ील्ड खुद भरें"),
        whatHappened: line(`${task}${field} may contain private information.`, `${task}${field} में निजी जानकारी हो सकती है।`),
        whatToDo: [
          line(`I will not type here because it is ${context.fieldReason || "sensitive"}.`, `मैं इसमें टाइप नहीं करूँगा क्योंकि यह ${context.fieldReason || "संवेदनशील फ़ील्ड"} है।`),
          line("Fill it yourself, then say 'done' or tap Continue.", "इसे खुद भरें, फिर 'done' कहें या Continue दबाएँ।"),
        ],
        actions: [action(context, "Continue", "जारी रखें", "resume")],
      };
    }
    case "question":
      return {
        reason,
        title: title("I need your answer", "मुझे आपका जवाब चाहिए"),
        whatHappened: context.error || line("The next step needs information from you.", "अगले कदम के लिए आपकी जानकारी चाहिए।"),
        whatToDo: [line("Answer the question below.", "नीचे दिए सवाल का जवाब दें।")],
        actions: [action(context, "Answer", "जवाब दें", "resume")],
      };
    case "max_steps":
      return {
        reason,
        title: title("The task needs more steps", "इस काम के लिए और चरण चाहिए"),
        whatHappened: line(`I used the current step budget. Done: ${context.completed || "nothing recorded"}.`, `मैंने मौजूदा चरण सीमा पूरी कर ली। पूरा: ${context.completed || "कुछ दर्ज नहीं"}।`),
        whatToDo: [line(`Still remaining: ${context.remaining || "the requested task"}.`, `अभी बाकी: ${context.remaining || "मांगा गया काम"}।`)],
        actions: context.error === "hard-cap"
          ? [action(context, "Start a clearer command", "स्पष्ट कमांड से शुरू करें", "dismiss")]
          : [action(context, "Continue 15 more steps", "15 चरण और जारी रखें", "continue_more")],
      };
    case "repeated_action":
      return {
        reason,
        title: title("I already did that and nothing changed", "मैंने यह पहले ही किया था और कुछ नहीं बदला"),
        whatHappened: context.error || line("The same action was suggested again without a clear change.", "वही कार्रवाई फिर सुझाई गई, लेकिन कोई स्पष्ट बदलाव नहीं हुआ।"),
        whatToDo: [
          line(`I currently see ${context.pageTitle || "the current page"}. ${context.pageSummary || "The page summary is unavailable."}`, `अभी मुझे ${context.pageTitle || "वर्तमान पेज"} दिख रहा है। ${context.pageSummary || "पेज का सार उपलब्ध नहीं है।"}`),
          line("Tell me the next button, scroll to the right place, or open the correct page and say continue.", "अगला बटन बताएं, सही जगह स्क्रॉल करें, या सही पेज खोलकर continue कहें।"),
        ],
        actions: [action(context, "Continue", "जारी रखें", "resume"), action(context, "Retry", "फिर कोशिश करें", "retry")],
      };
    case "no_progress":
      return {
        reason,
        title: title("I am stuck and paused", "मैं अटक गया हूँ और रुक गया हूँ"),
        whatHappened: line(`I tried ${context.tried?.join(", ") || "the last actions"}, but the page did not move.`, `मैंने ${context.tried?.join(", ") || "पिछली कार्रवाइयाँ"} कीं, लेकिन पेज नहीं बदला।`),
        whatToDo: [
          line(`I currently see ${context.pageTitle || "the current page"}. ${context.pageSummary || "The page summary is unavailable."}`, `अभी मुझे ${context.pageTitle || "वर्तमान पेज"} दिख रहा है। ${context.pageSummary || "पेज का सार उपलब्ध नहीं है।"}`),
          line("Scroll down, tell me which button to click, or open the right page yourself and say continue.", "नीचे स्क्रॉल करें, बताएं किस बटन पर क्लिक करना है, या सही पेज खुद खोलकर continue कहें।"),
        ],
        actions: [action(context, "Continue", "जारी रखें", "resume"), action(context, "Retry", "फिर कोशिश करें", "retry")],
      };
    case "stale_element":
      return {
        reason,
        title: title("The page changed while I was acting", "कार्रवाई के दौरान पेज बदल गया"),
        whatHappened: line(`The target control is no longer where I saw it. I tried ${context.tried?.join(", ") || "the last action"}.`, `जिस नियंत्रण को मैंने देखा था वह अब वहाँ नहीं है। मैंने ${context.tried?.join(", ") || "पिछली कार्रवाई"} की।`),
        whatToDo: [
          line(`I currently see ${context.pageTitle || "the current page"}. ${context.pageSummary || "The page summary is unavailable."}`, `अभी मुझे ${context.pageTitle || "वर्तमान पेज"} दिख रहा है। ${context.pageSummary || "पेज का सार उपलब्ध नहीं है।"}`),
          line("Refresh the page or open the correct page, then continue.", "पेज रीफ़्रेश करें या सही पेज खोलें, फिर continue कहें।"),
        ],
        actions: [action(context, "Retry", "फिर कोशिश करें", "retry"), action(context, "Continue", "जारी रखें", "resume")],
      };
    case "action_failed":
      return {
        reason,
        title: title("That action did not complete", "वह कार्रवाई पूरी नहीं हुई"),
        whatHappened: `${context.error || line("The page rejected the action.", "पेज ने कार्रवाई स्वीकार नहीं की।")} ${context.tried?.length ? line(`I tried ${context.tried.join(", ")}.`, `मैंने ${context.tried.join(", ")} की।`) : ""}`.trim(),
        whatToDo: [
          line(`I currently see ${context.pageTitle || "the current page"}. ${context.pageSummary || "The page summary is unavailable."}`, `अभी मुझे ${context.pageTitle || "वर्तमान पेज"} दिख रहा है। ${context.pageSummary || "पेज का सार उपलब्ध नहीं है।"}`),
          line("Check the page and try again, or tell me the next button.", "पेज जाँचें और फिर कोशिश करें, या अगला बटन बताएं।"),
        ],
        actions: commonRetry,
      };
    case "navigation_blocked":
    case "restricted_page":
      return {
        reason,
        title: title("I cannot control this page", "मैं इस पेज को नियंत्रित नहीं कर सकता"),
        whatHappened: line("Chrome blocks extensions on this page.", "Chrome इस पेज पर extensions को रोकता है।"),
        whatToDo: [line("Open a normal website, then say continue.", "सामान्य वेबसाइट खोलें, फिर continue कहें।")],
        actions: [action(context, "Open Google", "Google खोलें", "open_url", "https://www.google.com"), action(context, "Open YouTube", "YouTube खोलें", "open_url", "https://www.youtube.com")],
      };
    case "no_api_key":
      return {
        reason,
        title: title("Planner key is missing", "Planner key नहीं मिली"),
        whatHappened: line("The selected online planner needs an API key.", "चुने हुए online planner के लिए API key चाहिए।"),
        whatToDo: [line("Add the key in Settings, then retry.", "Settings में key जोड़ें, फिर retry करें।")],
        actions: [action(context, "Open Settings", "Settings खोलें", "open_settings"), ...commonRetry],
      };
    case "invalid_api_key":
      return {
        reason,
        title: title("The planner key was rejected", "Planner key स्वीकार नहीं हुई"),
        whatHappened: line(context.error || "The provider rejected the API key.", context.error || "Provider ने API key अस्वीकार कर दी।"),
        whatToDo: [line("Check the key in Settings, then retry.", "Settings में key जाँचें, फिर retry करें।")],
        actions: [action(context, "Open Settings", "Settings खोलें", "open_settings"), ...commonRetry],
      };
    case "rate_limited":
      return {
        reason,
        title: title("The planner is rate limited", "Planner पर rate limit है"),
        whatHappened: line(`I retried the planner. Try again in ${context.retryAfterSeconds || 1} seconds.`, `मैंने planner को फिर आज़माया। ${context.retryAfterSeconds || 1} सेकंड बाद फिर कोशिश करें।`),
        whatToDo: [line("Wait, then tap Retry.", "रुकें, फिर Retry दबाएँ।")],
        actions: commonRetry,
      };
    case "network_error":
      return {
        reason,
        title: title("The network request failed", "Network request विफल हुई"),
        whatHappened: line(context.error || "The planner could not reach its service.", context.error || "Planner service तक पहुँचा नहीं जा सका।"),
        whatToDo: [line("Check your connection and retry.", "अपना connection जाँचें और retry करें।")],
        actions: commonRetry,
      };
    case "planner_error":
      return {
        reason,
        title: title("I could not plan the next step", "मैं अगले चरण की योजना नहीं बना सका"),
        whatHappened: line(context.error || "The planner returned an unusable answer.", context.error || "Planner ने उपयोगी जवाब नहीं दिया।"),
        whatToDo: [line("Give a clearer instruction or retry.", "स्पष्ट निर्देश दें या retry करें।")],
        actions: [action(context, "Retry", "फिर कोशिश करें", "retry"), action(context, "Dismiss", "बंद करें", "dismiss")],
      };
    case "mic_denied":
      return {
        reason,
        title: title("Microphone access is needed", "Microphone की अनुमति चाहिए"),
        whatHappened: line("Chrome did not allow microphone access.", "Chrome ने microphone की अनुमति नहीं दी।"),
        whatToDo: [line("Allow the microphone, then try voice again.", "Microphone की अनुमति दें, फिर voice दोबारा आज़माएँ।")],
        actions: [action(context, "Open Settings", "Settings खोलें", "open_settings"), action(context, "Dismiss", "बंद करें", "dismiss")],
      };
    case "tab_closed":
      return {
        reason,
        title: title("The task tab was closed", "काम वाला टैब बंद हो गया"),
        whatHappened: line("I cannot continue without that tab.", "उस टैब के बिना मैं जारी नहीं रख सकता।"),
        whatToDo: [line("Reopen the page and start the task again.", "पेज फिर खोलें और काम दोबारा शुरू करें।")],
        actions: [action(context, "Retry", "फिर कोशिश करें", "retry"), action(context, "Dismiss", "बंद करें", "dismiss")],
      };
    case "load_timeout":
      return {
        reason,
        title: title("The page took too long to load", "पेज लोड होने में बहुत समय लगा"),
        whatHappened: line(context.error || "The tab did not finish loading in time.", context.error || "टैब समय पर लोड नहीं हुआ।"),
        whatToDo: [line("Check the tab, then retry.", "टैब जाँचें, फिर retry करें।")],
        actions: commonRetry,
      };
    case "payment_incomplete":
      return {
        reason,
        title: title("Payment is not confirmed", "भुगतान की पुष्टि नहीं हुई"),
        whatHappened: line("I cannot see a successful receipt yet.", "मुझे अभी सफल receipt नहीं दिख रही।"),
        whatToDo: [line("Review the payment page yourself, then say continue.", "Payment page खुद जाँचें, फिर continue कहें।")],
        actions: [action(context, "Continue", "जारी रखें", "resume"), action(context, "Dismiss", "बंद करें", "dismiss")],
      };
    case "stopped":
      return {
        reason,
        title: title("The task was stopped", "काम रोक दिया गया"),
        whatHappened: line("I stopped all actions and speech.", "मैंने सभी कार्रवाइयाँ और speech रोक दी है।"),
        whatToDo: [line("Start the command again when you are ready.", "तैयार होने पर command फिर शुरू करें।")],
        actions: [action(context, "Dismiss", "बंद करें", "dismiss")],
      };
  }
}
