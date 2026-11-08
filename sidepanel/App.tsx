/**
 * Browse Voice - Chrome Side Panel Agent Controller (React 19)
 *
 * Implements the full Phase 1 agent loop:
 * 1. User speaks -> Gnani Prisma streams transcript to panel.
 * 2. On end of utterance -> observer returns page snapshot.
 * 3. Planner receives: user request, snapshot, last 5 steps -> returns ONE action.
 * 4. Safety inspection (sensitive fields blocked, confirmation gated for submit/pay).
 * 5. Executor runs action in tab, waits for settle, re-observes.
 * 6. Gnani Timbre speaks one short sentence about the action.
 * 7. Repeats until done(), ask_user(), "ruko"/"stop", or max 15 steps.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  speakWithTimbre,
  stopAllSpeech,
  GnaniPrismaWebSocketClient,
  SUPPORTED_INDIAN_LANGUAGES,
  type GnaniConfig,
} from "../lib/gnani";
import {
  describePlannerMode,
  answerAboutSnips,
  convertFormAnswerToEnglish,
  decomposeRequest,
  fallbackToSingleTask,
  shouldCallDecompositionModel,
  answerAboutPage,
  resolvePlanner,
  type StepLogEntry,
  type SnipContext,
} from "../lib/planner";
import {
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  isCancellationCommand,
  type PageSnapshot,
} from "../lib/safety";
import { validatePlannerAction, type PlannerAction } from "../lib/schema";
import type { SubTask } from "../lib/schema";
import { getPlannerRetryAfterMs, isPlannerRateLimitError } from "../lib/planner";
import { buildGuidance, type Guidance, type GuidanceAction } from "../lib/guidance";
import {
  buildFillAction,
  collectFormFields,
  findFormField,
  isFormFillIntent,
  mergeFormSessionFields,
  resolveAmbiguousAnswerWithLLM,
  resolveFormAnswer,
  understandFormFields,
  verifyFilledValue,
  type FormFillSession,
} from "../lib/form-model";
import { MicrophoneSession } from "./mic";
import {
  askSiteQuestion,
  getSiteIndexProgress,
  startSiteIndexing,
  type SiteChatHistoryEntry,
  type SiteIndexProgress,
  type SiteIndexStatus,
} from "../lib/site-chat";
import { requestSiteSafety, type SiteSafetyResult } from "../lib/site-safety";
import {
  createTaskRunnerContext,
  applyTaskGuidance,
  resumeAgentTask,
  runAgentTask,
  stopAgentTask,
  stopAgentTasks,
  type TaskRunnerContext,
  type TaskRunnerResult,
  type TaskRunnerStatus,
} from "./taskRunner";

type AgentStatus =
  | "idle"
  | "listening"
  | "thinking"
  | "executing"
  | "speaking"
  | "confirmation"
  | "stopped";

interface SettingsState {
  gnaniApiKey: string;
  languageCode: string;
  /** Planner API used for browser actions. */
  llmProvider: "mock" | "openai-compatible" | "huggingface" | "gemini";
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
  siteChatEndpoint: string;
  siteChatApiKey: string;
  siteChatMaxPages: number;
  taskConcurrency: number;
  focusCompletedTab: boolean;
}

function isCurrentPageQuestion(text: string): boolean {
  return /\b(?:what does this mean|what is this|explain this|explain the page|what does .* mean|what is on this page|summarize this page)\b|इसका मतलब|समझाओ|इस पेज पर क्या/i.test(text.trim());
}

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const HUGGINGFACE_ENDPOINT = "https://router.huggingface.co/v1";
const DEFAULT_HUGGINGFACE_MODEL = "openai/gpt-oss-20b:deepinfra";
const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

const DEFAULT_SETTINGS: SettingsState = {
  gnaniApiKey: (import.meta.env.VITE_GNANI_API_KEY as string) || "",
  languageCode: (import.meta.env.VITE_LANGUAGE_CODE as string) || "en-IN",
  llmProvider:
    (import.meta.env.VITE_LLM_PROVIDER as "mock" | "openai-compatible" | "huggingface" | "gemini") ||
    (import.meta.env.VITE_GEMINI_API_KEY
      ? "gemini"
      : import.meta.env.VITE_LLM_API_KEY
        ? "openai-compatible"
        : "mock"),
  // Unified API key field: Gemini key takes priority, fallback to generic LLM key
  llmApiKey:
    (import.meta.env.VITE_GEMINI_API_KEY as string) ||
    (import.meta.env.VITE_LLM_API_KEY as string) ||
    "",
  llmEndpoint: (import.meta.env.VITE_LLM_PROVIDER === "huggingface"
    ? HUGGINGFACE_ENDPOINT
    : (import.meta.env.VITE_LLM_ENDPOINT as string) || "https://api.openai.com/v1"),
  llmModel: (import.meta.env.VITE_LLM_MODEL as string) ||
    (import.meta.env.VITE_LLM_PROVIDER === "huggingface" ? DEFAULT_HUGGINGFACE_MODEL : DEFAULT_GEMINI_MODEL),
  siteChatEndpoint: (import.meta.env.VITE_SITE_CHAT_ENDPOINT as string) || "",
  siteChatApiKey: (import.meta.env.VITE_SITE_CHAT_API_KEY as string) || "",
  siteChatMaxPages: Number(import.meta.env.VITE_SITE_CHAT_MAX_PAGES || 25),
  taskConcurrency: 3,
  focusCompletedTab: false,
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface TaskCardState {
  id: string;
  label: string;
  tabId: number | null;
  tabTitle: string;
  faviconUrl?: string;
  status: TaskRunnerStatus;
  currentStep: string;
  steps: StepLogEntry[];
  confirmationMessage?: string;
  summary?: string;
  error?: string;
  guidance?: Guidance;
}

interface SiteChatState {
  status: SiteIndexStatus | "idle";
  startUrl: string;
  siteId: string;
  jobId: string;
  pagesIndexed: number;
  totalPages?: number;
  message: string;
}

type InterfaceLanguage = "hi-IN" | "en-IN" | "ta-IN" | "te-IN" | "kn-IN" | "mr-IN" | "gu-IN" | "bn-IN" | "pa-IN" | "ml-IN" | "indic-auto";

const UI_TRANSLATIONS: Record<string, Partial<Record<InterfaceLanguage, string>>> = {
  Ready: { "hi-IN": "तैयार", "ta-IN": "தயார்", "te-IN": "సిద్ధంగా ఉంది", "kn-IN": "ಸಿದ್ಧ", "mr-IN": "तयार", "gu-IN": "તૈયાર", "bn-IN": "প্রস্তুত", "pa-IN": "ਤਿਆਰ", "ml-IN": "തയ്യാർ" },
  Stop: { "hi-IN": "रोकें", "ta-IN": "நிறுத்து", "te-IN": "ఆపండి", "kn-IN": "ನಿಲ್ಲಿಸಿ", "mr-IN": "थांबवा", "gu-IN": "રોકો", "bn-IN": "থামান", "pa-IN": "ਰੋਕੋ", "ml-IN": "നിർത്തുക" },
  Settings: { "hi-IN": "सेटिंग्स", "ta-IN": "அமைப்புகள்", "te-IN": "సెట్టింగ్‌లు", "kn-IN": "ಸೆಟ್ಟಿಂಗ್‌ಗಳು", "mr-IN": "सेटिंग्ज", "gu-IN": "સેટિંગ્સ", "bn-IN": "সেটিংস", "pa-IN": "ਸੈਟਿੰਗਾਂ", "ml-IN": "ക്രമീകരണങ്ങൾ" },
  "Restricted page": { "hi-IN": "प्रतिबंधित पेज", "ta-IN": "தடைசெய்யப்பட்ட பக்கம்", "te-IN": "పరిమితం చేయబడిన పేజీ", "kn-IN": "ನಿರ್ಬಂಧಿತ ಪುಟ", "mr-IN": "प्रतिबंधित पेज", "gu-IN": "પ્રતિબંધિત પેજ", "bn-IN": "সীমাবদ্ধ পৃষ্ঠা", "pa-IN": "ਪ੍ਰਤਿਬੰਧਿਤ ਪੰਨਾ", "ml-IN": "നിയന്ത്രിത പേജ്" },
  "Confirmation required": { "hi-IN": "पुष्टि आवश्यक है", "ta-IN": "உறுதிப்படுத்தல் தேவை", "te-IN": "నిర్ధారణ అవసరం", "kn-IN": "ದೃಢೀಕರಣ ಅಗತ್ಯವಿದೆ", "mr-IN": "पुष्टी आवश्यक आहे", "gu-IN": "પુષ્ટિ જરૂરી છે", "bn-IN": "নিশ্চিতকরণ প্রয়োজন", "pa-IN": "ਪੁਸ਼ਟੀ ਲੋੜੀਂਦੀ ਹੈ", "ml-IN": "സ്ഥിരീകരണം ആവശ്യമാണ്" },
  Confirm: { "hi-IN": "पुष्टि करें", "ta-IN": "உறுதிப்படுத்து", "te-IN": "నిర్ధారించండి", "kn-IN": "ದೃಢೀಕರಿಸಿ", "mr-IN": "पुष्टी करा", "gu-IN": "પુષ્ટિ કરો", "bn-IN": "নিশ্চিত করুন", "pa-IN": "ਪੁਸ਼ਟੀ ਕਰੋ", "ml-IN": "സ്ഥിരീകരിക്കുക" },
  Cancel: { "hi-IN": "रद्द करें", "ta-IN": "ரத்துசெய்", "te-IN": "రద్దు చేయండి", "kn-IN": "ರದ್ದುಮಾಡಿ", "mr-IN": "रद्द करा", "gu-IN": "રદ કરો", "bn-IN": "বাতিল করুন", "pa-IN": "ਰੱਦ ਕਰੋ", "ml-IN": "റദ്ദാക്കുക" },
  "VOICE CONTROL": { "hi-IN": "वॉइस कंट्रोल", "ta-IN": "குரல் கட்டுப்பாடு", "te-IN": "వాయిస్ నియంత్రణ", "kn-IN": "ಧ್ವನಿ ನಿಯಂತ್ರಣ", "mr-IN": "व्हॉइस कंट्रोल", "gu-IN": "વૉઇસ કંટ્રોલ", "bn-IN": "ভয়েস কন্ট্রোল", "pa-IN": "ਵੌਇਸ ਕੰਟਰੋਲ", "ml-IN": "വോയ്സ് കൺട്രോൾ" },
  "Select area": { "hi-IN": "क्षेत्र चुनें", "ta-IN": "பகுதியைத் தேர்ந்தெடுக்கவும்", "te-IN": "ప్రాంతాన్ని ఎంచుకోండి", "kn-IN": "ಪ್ರದೇಶ ಆಯ್ಕೆಮಾಡಿ", "mr-IN": "क्षेत्र निवडा", "gu-IN": "વિસ્તાર પસંદ કરો", "bn-IN": "এলাকা নির্বাচন করুন", "pa-IN": "ਖੇਤਰ ਚੁਣੋ", "ml-IN": "ഏരിയ തിരഞ്ഞെടുക്കുക" },
  "Indexing…": { "hi-IN": "इंडेक्स हो रहा है…", "ta-IN": "அட்டவணைப்படுத்தப்படுகிறது…", "te-IN": "ఇండెక్స్ అవుతోంది…", "kn-IN": "ಇಂಡೆಕ್ಸ್ ಆಗುತ್ತಿದೆ…", "mr-IN": "इंडेक्स होत आहे…", "gu-IN": "ઇન્ડેક્સ થઈ રહ્યું છે…", "bn-IN": "ইনডেক্স হচ্ছে…", "pa-IN": "ਇੰਡੈਕਸ ਹੋ ਰਿਹਾ ਹੈ…", "ml-IN": "ഇൻഡക്സ് ചെയ്യുന്നു…" },
  "Chat with site": { "hi-IN": "साइट से चैट करें", "ta-IN": "தளத்துடன் அரட்டையடிக்கவும்", "te-IN": "సైట్‌తో చాట్ చేయండి", "kn-IN": "ಸೈಟ್‌ನೊಂದಿಗೆ ಚಾಟ್ ಮಾಡಿ", "mr-IN": "साइटशी चॅट करा", "gu-IN": "સાઇટ સાથે ચેટ કરો", "bn-IN": "সাইটের সঙ্গে চ্যাট করুন", "pa-IN": "ਸਾਈਟ ਨਾਲ ਚੈਟ ਕਰੋ", "ml-IN": "സൈറ്റുമായി ചാറ്റ് ചെയ്യുക" },
  "Listening…": { "hi-IN": "सुन रहे हैं…", "ta-IN": "கேட்கிறது…", "te-IN": "వింటున్నాం…", "kn-IN": "ಕೇಳುತ್ತಿದೆ…", "mr-IN": "ऐकत आहे…", "gu-IN": "સાંભળી રહ્યા છીએ…", "bn-IN": "শুনছি…", "pa-IN": "ਸੁਣ ਰਹੇ ਹਾਂ…", "ml-IN": "കേൾക്കുന്നു…" },
  "Tap mic to speak": { "hi-IN": "बोलने के लिए माइक दबाएं", "ta-IN": "பேச மைக்கைத் தட்டவும்", "te-IN": "మాట్లాడటానికి మైక్‌ను నొక్కండి", "kn-IN": "ಮಾತನಾಡಲು ಮೈಕ್ ಟ್ಯಾಪ್ ಮಾಡಿ", "mr-IN": "बोलण्यासाठी माइक टॅप करा", "gu-IN": "બોલવા માટે માઇક દબાવો", "bn-IN": "কথা বলতে মাইক ট্যাপ করুন", "pa-IN": "ਬੋਲਣ ਲਈ ਮਾਈਕ ਟੈਪ ਕਰੋ", "ml-IN": "സംസാരിക്കാൻ മൈക്ക് ടാപ്പ് ചെയ്യുക" },
  "Speak naturally or try a quick prompt": { "hi-IN": "स्वाभाविक रूप से बोलें या quick prompt चुनें", "ta-IN": "இயல்பாகப் பேசவும் அல்லது quick prompt முயற்சிக்கவும்", "te-IN": "సహజంగా మాట్లాడండి లేదా quick prompt ప్రయత్నించండి", "kn-IN": "ಸ್ವಾಭಾವಿಕವಾಗಿ ಮಾತನಾಡಿ ಅಥವಾ quick prompt ಪ್ರಯತ್ನಿಸಿ", "mr-IN": "नैसर्गिकपणे बोला किंवा quick prompt वापरा", "gu-IN": "સહજ રીતે બોલો અથવા quick prompt અજમાવો", "bn-IN": "স্বাভাবিকভাবে বলুন বা quick prompt চেষ্টা করুন", "pa-IN": "ਕੁਦਰਤੀ ਤੌਰ 'ਤੇ ਬੋਲੋ ਜਾਂ quick prompt ਅਜ਼ਮਾਓ", "ml-IN": "സ്വാഭാവികമായി സംസാരിക്കുക അല്ലെങ്കിൽ quick prompt പരീക്ഷിക്കുക" },
  "Check electricity bill": { "hi-IN": "बिजली का बिल देखें", "ta-IN": "மின்சாரக் கட்டணத்தைச் சரிபார்க்கவும்", "te-IN": "విద్యుత్ బిల్లును తనిఖీ చేయండి", "kn-IN": "ವಿದ್ಯುತ್ ಬಿಲ್ ಪರಿಶೀಲಿಸಿ", "mr-IN": "वीज बिल तपासा", "gu-IN": "વીજળીનું બિલ તપાસો", "bn-IN": "বিদ্যুৎ বিল পরীক্ষা করুন", "pa-IN": "ਬਿਜਲੀ ਦਾ ਬਿੱਲ ਚੈੱਕ ਕਰੋ", "ml-IN": "വൈദ്യുതി ബിൽ പരിശോധിക്കുക" },
  "Pay utility bill": { "hi-IN": "बिजली का बिल भरें", "ta-IN": "மின்சாரக் கட்டணத்தைச் செலுத்தவும்", "te-IN": "విద్యుత్ బిల్లు చెల్లించండి", "kn-IN": "ವಿದ್ಯುತ್ ಬಿಲ್ ಪಾವತಿಸಿ", "mr-IN": "वीज बिल भरा", "gu-IN": "વીજળીનું બિલ ભરો", "bn-IN": "বিদ্যুৎ বিল পরিশোধ করুন", "pa-IN": "ਬਿਜਲੀ ਦਾ ਬਿੱਲ ਭਰੋ", "ml-IN": "വൈദ്യുതി ബിൽ അടയ്ക്കുക" },
  "Download payment receipt": { "hi-IN": "भुगतान रसीद डाउनलोड करें", "ta-IN": "கட்டண ரசீதைப் பதிவிறக்கவும்", "te-IN": "చెల్లింపు రసీదును డౌన్‌లోడ్ చేయండి", "kn-IN": "ಪಾವತಿ ರಸೀದಿಯನ್ನು ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ", "mr-IN": "पेमेंट पावती डाउनलोड करा", "gu-IN": "ચુકવણીની રસીદ ડાઉનલોડ કરો", "bn-IN": "পেমেন্ট রসিদ ডাউনলোড করুন", "pa-IN": "ਭੁਗਤਾਨ ਦੀ ਰਸੀਦ ਡਾਊਨਲੋਡ ਕਰੋ", "ml-IN": "പേയ്മെന്റ് രസീത് ഡൗൺലോഡ് ചെയ്യുക" },
  "Live Transcript": { "hi-IN": "लाइव ट्रांसक्रिप्ट", "ta-IN": "நேரடி உரை", "te-IN": "లైవ్ ట్రాన్స్‌క్రిప్ట్", "kn-IN": "ಲೈವ್ ಪ್ರತಿಲಿಪಿ", "mr-IN": "लाइव्ह ट्रान्सक्रिप्ट", "gu-IN": "લાઇવ ટ્રાન્સક્રિપ્ટ", "bn-IN": "লাইভ ট্রান্সক্রিপ্ট", "pa-IN": "ਲਾਈਵ ਟ੍ਰਾਂਸਕ੍ਰਿਪਟ", "ml-IN": "ലൈവ് ട്രാൻസ്ക്രിപ്റ്റ്" },
  "Selected context": { "hi-IN": "चयनित संदर्भ", "ta-IN": "தேர்ந்தெடுக்கப்பட்ட சூழல்", "te-IN": "ఎంచుకున్న సందర్భం", "kn-IN": "ಆಯ್ಕೆಮಾಡಿದ ಸಂದರ್ಭ", "mr-IN": "निवडलेला संदर्भ", "gu-IN": "પસંદ કરેલો સંદર્ભ", "bn-IN": "নির্বাচিত প্রসঙ্গ", "pa-IN": "ਚੁਣਿਆ ਸੰਦਰਭ", "ml-IN": "തിരഞ്ഞെടുത്ത സന്ദർഭം" },
  Area: { "hi-IN": "क्षेत्र", "ta-IN": "பகுதி", "te-IN": "ప్రాంతం", "kn-IN": "ಪ್ರದೇಶ", "mr-IN": "क्षेत्र", "gu-IN": "વિસ્તાર", "bn-IN": "এলাকা", "pa-IN": "ਖੇਤਰ", "ml-IN": "ഏരിയ" },
  Clear: { "hi-IN": "साफ़ करें", "ta-IN": "அழிக்கவும்", "te-IN": "క్లియర్ చేయండి", "kn-IN": "ತೆರವುಗೊಳಿಸಿ", "mr-IN": "साफ करा", "gu-IN": "સાફ કરો", "bn-IN": "পরিষ্কার করুন", "pa-IN": "ਸਾਫ਼ ਕਰੋ", "ml-IN": "മായ്ക്കുക" },
  "Indexed and ready for questions": { "hi-IN": "इंडेक्स तैयार है, आप सवाल पूछ सकते हैं", "ta-IN": "அட்டவணை தயாராக உள்ளது, கேள்விகளைக் கேட்கலாம்", "te-IN": "ఇండెక్స్ సిద్ధంగా ఉంది, ప్రశ్నలు అడగవచ్చు", "kn-IN": "ಇಂಡೆಕ್ಸ್ ಸಿದ್ಧವಾಗಿದೆ, ಪ್ರಶ್ನೆಗಳನ್ನು ಕೇಳಬಹುದು", "mr-IN": "इंडेक्स तयार आहे, तुम्ही प्रश्न विचारू शकता", "gu-IN": "ઇન્ડેક્સ તૈયાર છે, તમે પ્રશ્નો પૂછી શકો છો", "bn-IN": "ইনডেক্স প্রস্তুত, প্রশ্ন করতে পারেন", "pa-IN": "ਇੰਡੈਕਸ ਤਿਆਰ ਹੈ, ਤੁਸੀਂ ਸਵਾਲ ਪੁੱਛ ਸਕਦੇ ਹੋ", "ml-IN": "ഇൻഡക്സ് തയ്യാറാണ്, ചോദ്യങ്ങൾ ചോദിക്കാം" },
  "Indexing failed": { "hi-IN": "इंडेक्सिंग विफल रही", "ta-IN": "அட்டவணைப்படுத்தல் தோல்வியடைந்தது", "te-IN": "ఇండెక్సింగ్ విఫలమైంది", "kn-IN": "ಇಂಡೆಕ್ಸಿಂಗ್ ವಿಫಲವಾಗಿದೆ", "mr-IN": "इंडेक्सिंग अयशस्वी झाले", "gu-IN": "ઇન્ડેક્સિંગ નિષ્ફળ થયું", "bn-IN": "ইনডেক্সিং ব্যর্থ হয়েছে", "pa-IN": "ਇੰਡੈਕਸਿੰਗ ਅਸਫਲ ਰਹੀ", "ml-IN": "ഇൻഡക്സിംഗ് പരാജയപ്പെട്ടു" },
  "Crawler is working": { "hi-IN": "क्रॉलर काम कर रहा है", "ta-IN": "கிராலர் வேலை செய்கிறது", "te-IN": "క్రాలర్ పని చేస్తోంది", "kn-IN": "ಕ್ರಾಲರ್ ಕೆಲಸ ಮಾಡುತ್ತಿದೆ", "mr-IN": "क्रॉलर काम करत आहे", "gu-IN": "ક્રૉલર કામ કરી રહ્યું છે", "bn-IN": "ক্রলার কাজ করছে", "pa-IN": "ਕ੍ਰਾਲਰ ਕੰਮ ਕਰ ਰਿਹਾ ਹੈ", "ml-IN": "ക്രാളർ പ്രവർത്തിക്കുന്നു" },
  pages: { "hi-IN": "पेज", "ta-IN": "பக்கங்கள்", "te-IN": "పేజీలు", "kn-IN": "ಪುಟಗಳು", "mr-IN": "पेज", "gu-IN": "પેજ", "bn-IN": "পৃষ্ঠা", "pa-IN": "ਪੰਨੇ", "ml-IN": "പേജുകൾ" },
  You: { "hi-IN": "आप", "ta-IN": "நீங்கள்", "te-IN": "మీరు", "kn-IN": "ನೀವು", "mr-IN": "तुम्ही", "gu-IN": "તમે", "bn-IN": "আপনি", "pa-IN": "ਤੁਸੀਂ", "ml-IN": "നിങ്ങൾ" },
  "Site knowledge": { "hi-IN": "साइट नॉलेज", "ta-IN": "தள அறிவு", "te-IN": "సైట్ నాలెడ్జ్", "kn-IN": "ಸೈಟ್ ಜ್ಞಾನ", "mr-IN": "साइट नॉलेज", "gu-IN": "સાઇટ નોલેજ", "bn-IN": "সাইট জ্ঞান", "pa-IN": "ਸਾਈਟ ਨੌਲੇਜ", "ml-IN": "സൈറ്റ് നോളജ്" },
  "Or type a command here...": { "hi-IN": "या यहां कमांड लिखें...", "ta-IN": "அல்லது கட்டளையை இங்கே தட்டச்சு செய்யவும்...", "te-IN": "లేదా ఇక్కడ కమాండ్ టైప్ చేయండి...", "kn-IN": "ಅಥವಾ ಇಲ್ಲಿ ಕಮಾಂಡ್ ಟೈಪ್ ಮಾಡಿ...", "mr-IN": "किंवा येथे कमांड टाइप करा...", "gu-IN": "અથવા અહીં કમાન્ડ લખો...", "bn-IN": "অথবা এখানে কমান্ড লিখুন...", "pa-IN": "ਜਾਂ ਇੱਥੇ ਕਮਾਂਡ ਟਾਈਪ ਕਰੋ...", "ml-IN": "അല്ലെങ്കിൽ ഇവിടെ കമാൻഡ് ടൈപ്പ് ചെയ്യുക..." },
  Send: { "hi-IN": "भेजें", "ta-IN": "அனுப்பு", "te-IN": "పంపండి", "kn-IN": "ಕಳುಹಿಸಿ", "mr-IN": "पाठवा", "gu-IN": "મોકલો", "bn-IN": "পাঠান", "pa-IN": "ਭੇਜੋ", "ml-IN": "അയയ്ക്കുക" },
  ACTIVITY: { "hi-IN": "गतिविधि", "ta-IN": "செயல்பாடு", "te-IN": "కార్యకలాపం", "kn-IN": "ಚಟುವಟಿಕೆ", "mr-IN": "गतिविधी", "gu-IN": "પ્રવૃત્તિ", "bn-IN": "কার্যকলাপ", "pa-IN": "ਗਤੀਵਿਧੀ", "ml-IN": "പ്രവർത്തനം" },
  "Execution steps": { "hi-IN": "एक्जीक्यूशन स्टेप्स", "ta-IN": "செயல்பாட்டு படிகள்", "te-IN": "అమలు దశలు", "kn-IN": "ಕಾರ್ಯಗತ ಹಂತಗಳು", "mr-IN": "अंमलबजावणीच्या पायऱ्या", "gu-IN": "અમલના પગલાં", "bn-IN": "সম্পাদনের ধাপ", "pa-IN": "ਕਾਰਵਾਈ ਦੇ ਕਦਮ", "ml-IN": "നിർവഹണ ഘട്ടങ്ങൾ" },
  "Your actions will appear here": { "hi-IN": "आपकी कार्रवाइयां यहां दिखाई देंगी", "ta-IN": "உங்கள் செயல்கள் இங்கே தோன்றும்", "te-IN": "మీ చర్యలు ఇక్కడ కనిపిస్తాయి", "kn-IN": "ನಿಮ್ಮ ಕ್ರಿಯೆಗಳು ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ", "mr-IN": "तुमच्या कृती येथे दिसतील", "gu-IN": "તમારી ક્રિયાઓ અહીં દેખાશે", "bn-IN": "আপনার কাজ এখানে দেখা যাবে", "pa-IN": "ਤੁਹਾਡੀਆਂ ਕਾਰਵਾਈਆਂ ਇੱਥੇ ਦਿਖਾਈ ਦੇਣਗੀਆਂ", "ml-IN": "നിങ്ങളുടെ പ്രവർത്തനങ്ങൾ ഇവിടെ കാണിക്കും" },
  "Automated web clicks, fills, and navigation will stream live": { "hi-IN": "वेब क्लिक, फिल और नेविगेशन यहां दिखाई देंगे", "ta-IN": "தானியங்கி கிளிக்குகள், நிரப்பல்கள் மற்றும் வழிசெலுத்தல் இங்கே தெரியும்", "te-IN": "ఆటోమేటెడ్ వెబ్ క్లిక్‌లు, ఫిల్‌లు మరియు నావిగేషన్ ఇక్కడ కనిపిస్తాయి", "kn-IN": "ಸ್ವಯಂಚಾಲಿತ ವೆಬ್ ಕ್ಲಿಕ್‌ಗಳು, ಭರ್ತಿಗಳು ಮತ್ತು ನ್ಯಾವಿಗೇಶನ್ ಇಲ್ಲಿ ಕಾಣಿಸುತ್ತವೆ", "mr-IN": "स्वयंचलित वेब क्लिक्स, फिल्स आणि नेव्हिगेशन येथे दिसेल", "gu-IN": "સ્વચાલિત વેબ ક્લિક્સ, ફિલ્સ અને નેવિગેશન અહીં દેખાશે", "bn-IN": "স্বয়ংক্রিয় ওয়েব ক্লিক, ফিল এবং নেভিগেশন এখানে দেখা যাবে", "pa-IN": "ਆਟੋਮੈਟਿਕ ਵੈੱਬ ਕਲਿੱਕ, ਫਿਲ ਅਤੇ ਨੈਵੀਗੇਸ਼ਨ ਇੱਥੇ ਦਿਖਾਈ ਦੇਵੇਗੀ", "ml-IN": "ഓട്ടോമേറ്റഡ് വെബ് ക്ലിക്കുകൾ, ഫില്ലുകൾ, നാവിഗേഷൻ എന്നിവ ഇവിടെ കാണിക്കും" },
  "Secure Web Sandbox Active": { "hi-IN": "सिक्योर वेब सैंडबॉक्स सक्रिय है", "ta-IN": "பாதுகாப்பான வலை சாண்ட்பாக்ஸ் செயலில் உள்ளது", "te-IN": "సురక్షిత వెబ్ శాండ్‌బాక్స్ యాక్టివ్‌గా ఉంది", "kn-IN": "ಸುರಕ್ಷಿತ ವೆಬ್ ಸ್ಯಾಂಡ್‌ಬಾಕ್ಸ್ ಸಕ್ರಿಯವಾಗಿದೆ", "mr-IN": "सिक्योर वेब सँडबॉक्स सक्रिय आहे", "gu-IN": "સિક્યોર વેબ સેન્ડબોક્સ સક્રિય છે", "bn-IN": "সুরক্ষিত ওয়েব স্যান্ডবক্স সক্রিয়", "pa-IN": "ਸੁਰੱਖਿਅਤ ਵੈੱਬ ਸੈਂਡਬਾਕਸ ਸਰਗਰਮ ਹੈ", "ml-IN": "സുരക്ഷിത വെബ് സാൻഡ്ബോക്സ് സജീവമാണ്" },
  Feedback: { "hi-IN": "फीडबैक", "ta-IN": "கருத்து", "te-IN": "ఫీడ్‌బ్యాక్", "kn-IN": "ಪ್ರತಿಕ್ರಿಯೆ", "mr-IN": "अभिप्राय", "gu-IN": "પ્રતિસાદ", "bn-IN": "মতামত", "pa-IN": "ਫੀਡਬੈਕ", "ml-IN": "ഫീഡ്ബാക്ക്" },
  Language: { "hi-IN": "भाषा", "ta-IN": "மொழி", "te-IN": "భాష", "kn-IN": "ಭಾಷೆ", "mr-IN": "भाषा", "gu-IN": "ભાષા", "bn-IN": "ভাষা", "pa-IN": "ਭਾਸ਼ਾ", "ml-IN": "ഭാഷ" },
  "Save Settings": { "hi-IN": "सेटिंग्स सेव करें", "ta-IN": "அமைப்புகளைச் சேமிக்கவும்", "te-IN": "సెట్టింగ్‌లను సేవ్ చేయండి", "kn-IN": "ಸೆಟ್ಟಿಂಗ್‌ಗಳನ್ನು ಉಳಿಸಿ", "mr-IN": "सेटिंग्ज सेव्ह करा", "gu-IN": "સેટિંગ્સ સાચવો", "bn-IN": "সেটিংস সংরক্ষণ করুন", "pa-IN": "ਸੈਟਿੰਗਾਂ ਸੇਵ ਕਰੋ", "ml-IN": "ക്രമീകരണങ്ങൾ സംരക്ഷിക്കുക" },
};

Object.assign(UI_TRANSLATIONS, {
  "Planner Provider": { "hi-IN": "प्लानर प्रोवाइडर", "ta-IN": "திட்டமிடுபவர் வழங்குநர்", "te-IN": "ప్లానర్ ప్రొవైడర్", "kn-IN": "ಪ್ಲಾನರ್ ಪೂರೈಕೆದಾರ", "mr-IN": "प्लॅनर प्रोव्हायडर", "gu-IN": "પ્લાનર પ્રોવાઇડર", "bn-IN": "প্ল্যানার প্রদানকারী", "pa-IN": "ਪਲੈਨਰ ਪ੍ਰਦਾਤਾ", "ml-IN": "പ്ലാനർ പ്രൊവൈഡർ" },
  "Site knowledge API endpoint": { "hi-IN": "साइट नॉलेज API endpoint", "ta-IN": "தள அறிவு API endpoint", "te-IN": "సైట్ నాలెడ్జ్ API endpoint", "kn-IN": "ಸೈಟ್ ಜ್ಞಾನ API endpoint", "mr-IN": "साइट नॉलेज API endpoint", "gu-IN": "સાઇટ નોલેજ API endpoint", "bn-IN": "সাইট জ্ঞান API endpoint", "pa-IN": "ਸਾਈਟ ਨੌਲੇਜ API endpoint", "ml-IN": "സൈറ്റ് നോളജ് API endpoint" },
  "Site knowledge API key (optional)": { "hi-IN": "साइट नॉलेज API key (वैकल्पिक)", "ta-IN": "தள அறிவு API key (விருப்பம்)", "te-IN": "సైట్ నాలెడ్జ్ API key (ఐచ్ఛికం)", "kn-IN": "ಸೈಟ್ ಜ್ಞಾನ API key (ಐಚ್ಛಿಕ)", "mr-IN": "साइट नॉलेज API key (पर्यायी)", "gu-IN": "સાઇટ નોલેજ API key (વૈકલ્પિક)", "bn-IN": "সাইট জ্ঞান API key (ঐচ্ছিক)", "pa-IN": "ਸਾਈਟ ਨੌਲੇਜ API key (ਵਿਕਲਪਿਕ)", "ml-IN": "സൈറ്റ് നോളജ് API key (ഓപ്ഷണൽ)" },
  "Maximum pages per site": { "hi-IN": "प्रति साइट अधिकतम पेज", "ta-IN": "ஒரு தளத்திற்கான அதிகபட்ச பக்கங்கள்", "te-IN": "సైట్‌కు గరిష్ట పేజీలు", "kn-IN": "ಪ್ರತಿ ಸೈಟ್‌ಗೆ ಗರಿಷ್ಠ ಪುಟಗಳು", "mr-IN": "प्रति साइट कमाल पेज", "gu-IN": "સાઇટ દીઠ મહત્તમ પેજ", "bn-IN": "প্রতি সাইটে সর্বাধিক পৃষ্ঠা", "pa-IN": "ਪ੍ਰਤੀ ਸਾਈਟ ਵੱਧ ਤੋਂ ਵੱਧ ਪੰਨੇ", "ml-IN": "ഒരു സൈറ്റിന് പരമാവധി പേജുകൾ" },
  "Answer ready": { "hi-IN": "जवाब तैयार है", "ta-IN": "பதில் தயாராக உள்ளது", "te-IN": "సమాధానం సిద్ధంగా ఉంది", "kn-IN": "ಉತ್ತರ ಸಿದ್ಧವಾಗಿದೆ", "mr-IN": "उत्तर तयार आहे", "gu-IN": "જવાબ તૈયાર છે", "bn-IN": "উত্তর প্রস্তুত", "pa-IN": "ਜਵਾਬ ਤਿਆਰ ਹੈ", "ml-IN": "ഉത്തരം തയ്യാറാണ്" },
  Completed: { "hi-IN": "पूरा हुआ", "ta-IN": "முடிந்தது", "te-IN": "పూర్తయింది", "kn-IN": "ಪೂರ್ಣಗೊಂಡಿದೆ", "mr-IN": "पूर्ण झाले", "gu-IN": "પૂર્ણ થયું", "bn-IN": "সম্পন্ন হয়েছে", "pa-IN": "ਪੂਰਾ ਹੋਇਆ", "ml-IN": "പൂർത്തിയായി" },
  Stopped: { "hi-IN": "रोक दिया गया", "ta-IN": "நிறுத்தப்பட்டது", "te-IN": "ఆపివేయబడింది", "kn-IN": "ನಿಲ್ಲಿಸಲಾಗಿದೆ", "mr-IN": "थांबवले", "gu-IN": "રોકવામાં આવ્યું", "bn-IN": "থামানো হয়েছে", "pa-IN": "ਰੋਕ ਦਿੱਤਾ ਗਿਆ", "ml-IN": "നിർത്തി" },
  "Site ready": { "hi-IN": "साइट तैयार है", "ta-IN": "தளம் தயாராக உள்ளது", "te-IN": "సైట్ సిద్ధంగా ఉంది", "kn-IN": "ಸೈಟ್ ಸಿದ್ಧವಾಗಿದೆ", "mr-IN": "साइट तयार आहे", "gu-IN": "સાઇટ તૈયાર છે", "bn-IN": "সাইট প্রস্তুত", "pa-IN": "ਸਾਈਟ ਤਿਆਰ ਹੈ", "ml-IN": "സൈറ്റ് തയ്യാറാണ്" },
  "Searching site knowledge...": { "hi-IN": "साइट नॉलेज खोज रहे हैं...", "ta-IN": "தள அறிவைத் தேடுகிறது...", "te-IN": "సైట్ నాలెడ్జ్‌ను వెతుకుతోంది...", "kn-IN": "ಸೈಟ್ ಜ್ಞಾನವನ್ನು ಹುಡುಕುತ್ತಿದೆ...", "mr-IN": "साइट नॉलेज शोधत आहे...", "gu-IN": "સાઇટ નોલેજ શોધી રહ્યા છીએ...", "bn-IN": "সাইট জ্ঞান খোঁজা হচ্ছে...", "pa-IN": "ਸਾਈਟ ਨੌਲੇਜ ਖੋਜ ਰਹੇ ਹਾਂ...", "ml-IN": "സൈറ്റ് നോളജ് തിരയുന്നു..." },
  "Could not answer": { "hi-IN": "जवाब नहीं मिल सका", "ta-IN": "பதில் கிடைக்கவில்லை", "te-IN": "సమాధానం ఇవ్వలేకపోయాం", "kn-IN": "ಉತ್ತರಿಸಲಾಗಲಿಲ್ಲ", "mr-IN": "उत्तर देता आले नाही", "gu-IN": "જવાબ આપી શકાયો નથી", "bn-IN": "উত্তর দেওয়া যায়নি", "pa-IN": "ਜਵਾਬ ਨਹੀਂ ਮਿਲ ਸਕਿਆ", "ml-IN": "ഉത്തരം നൽകാനായില്ല" },
  "Analyzing page...": { "hi-IN": "पेज का विश्लेषण हो रहा है...", "ta-IN": "பக்கம் பகுப்பாய்வு செய்யப்படுகிறது...", "te-IN": "పేజీని విశ్లేషిస్తోంది...", "kn-IN": "ಪುಟವನ್ನು ವಿಶ್ಲೇಷಿಸಲಾಗುತ್ತಿದೆ...", "mr-IN": "पेजचे विश्लेषण होत आहे...", "gu-IN": "પેજનું વિશ્લેષણ થઈ રહ્યું છે...", "bn-IN": "পৃষ্ঠা বিশ্লেষণ করা হচ্ছে...", "pa-IN": "ਪੰਨੇ ਦਾ ਵਿਸ਼ਲੇਸ਼ਣ ਹੋ ਰਿਹਾ ਹੈ...", "ml-IN": "പേജ് വിശകലനം ചെയ്യുന്നു..." },
  "Waiting for confirmation": { "hi-IN": "पुष्टि की प्रतीक्षा है", "ta-IN": "உறுதிப்படுத்தலுக்காக காத்திருக்கிறது", "te-IN": "నిర్ధారణ కోసం వేచి ఉంది", "kn-IN": "ದೃಢೀಕರಣಕ್ಕಾಗಿ ಕಾಯುತ್ತಿದೆ", "mr-IN": "पुष्टीची प्रतीक्षा आहे", "gu-IN": "પુષ્ટિની રાહ જોઈ રહ્યા છીએ", "bn-IN": "নিশ্চিতকরণের অপেক্ষায়", "pa-IN": "ਪੁਸ਼ਟੀ ਦੀ ਉਡੀਕ ਹੈ", "ml-IN": "സ്ഥിരീകരണത്തിനായി കാത്തിരിക്കുന്നു" },
  "Awaiting response": { "hi-IN": "जवाब की प्रतीक्षा है", "ta-IN": "பதிலுக்காக காத்திருக்கிறது", "te-IN": "సమాధానం కోసం వేచి ఉంది", "kn-IN": "ಪ್ರತಿಕ್ರಿಯೆಗಾಗಿ ಕಾಯುತ್ತಿದೆ", "mr-IN": "उत्तराची प्रतीक्षा आहे", "gu-IN": "જવાબની રાહ જોઈ રહ્યા છીએ", "bn-IN": "উত্তরের অপেক্ষায়", "pa-IN": "ਜਵਾਬ ਦੀ ਉਡੀਕ ਹੈ", "ml-IN": "പ്രതികരണത്തിനായി കാത്തിരിക്കുന്നു" },
  "Microphone access error": { "hi-IN": "माइक की अनुमति में त्रुटि", "ta-IN": "மைக்ரோஃபோன் அணுகல் பிழை", "te-IN": "మైక్రోఫోన్ యాక్సెస్ లోపం", "kn-IN": "ಮೈಕ್ರೊಫೋನ್ ಪ್ರವೇಶ ದೋಷ", "mr-IN": "मायक्रोफोन प्रवेश त्रुटी", "gu-IN": "માઇક્રોફોન ઍક્સેસ ભૂલ", "bn-IN": "মাইক্রোফোন অ্যাক্সেস ত্রুটি", "pa-IN": "ਮਾਈਕ੍ਰੋਫੋਨ ਪਹੁੰਚ ਗਲਤੀ", "ml-IN": "മൈക്രോഫോൺ ആക്സസ് പിശക്" },
  "Check site": { "hi-IN": "साइट जांचें", "ta-IN": "தளத்தைச் சரிபார்க்கவும்", "te-IN": "సైట్‌ను తనిఖీ చేయండి", "kn-IN": "ಸೈಟ್ ಪರಿಶೀಲಿಸಿ", "mr-IN": "साइट तपासा", "gu-IN": "સાઇટ તપાસો", "bn-IN": "সাইট পরীক্ষা করুন", "pa-IN": "ਸਾਈਟ ਜਾਂਚੋ", "ml-IN": "സൈറ്റ് പരിശോധിക്കുക" },
  "Checking…": { "hi-IN": "जांच हो रही है…", "ta-IN": "சரிபார்க்கிறது…", "te-IN": "తనిఖీ చేస్తోంది…", "kn-IN": "ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ…", "mr-IN": "तपासत आहे…", "gu-IN": "તપાસી રહ્યું છે…", "bn-IN": "পরীক্ষা করা হচ্ছে…", "pa-IN": "ਜਾਂਚ ਹੋ ਰਹੀ ਹੈ…", "ml-IN": "പരിശോധിക്കുന്നു…" },
  "Safety check complete": { "hi-IN": "सुरक्षा जांच पूरी हुई", "ta-IN": "பாதுகாப்புச் சரிபார்ப்பு முடிந்தது", "te-IN": "భద్రతా తనిఖీ పూర్తయింది", "kn-IN": "ಸುರಕ್ಷತಾ ಪರಿಶೀಲನೆ ಪೂರ್ಣಗೊಂಡಿದೆ", "mr-IN": "सुरक्षा तपासणी पूर्ण झाली", "gu-IN": "સુરક્ષા તપાસ પૂર્ણ થઈ", "bn-IN": "নিরাপত্তা পরীক্ষা সম্পন্ন হয়েছে", "pa-IN": "ਸੁਰੱਖਿਆ ਜਾਂਚ ਪੂਰੀ ਹੋਈ", "ml-IN": "സുരക്ഷാ പരിശോധന പൂർത്തിയായി" },
  "Checking site safety...": { "hi-IN": "साइट सुरक्षा जांच रहे हैं...", "ta-IN": "தளப் பாதுகாப்பைச் சரிபார்க்கிறது...", "te-IN": "సైట్ భద్రతను తనిఖీ చేస్తోంది...", "kn-IN": "ಸೈಟ್ ಸುರಕ್ಷತೆಯನ್ನು ಪರಿಶೀಲಿಸಲಾಗುತ್ತಿದೆ...", "mr-IN": "साइट सुरक्षेची तपासणी करत आहे...", "gu-IN": "સાઇટ સુરક્ષા તપાસી રહ્યા છીએ...", "bn-IN": "সাইটের নিরাপত্তা পরীক্ষা করা হচ্ছে...", "pa-IN": "ਸਾਈਟ ਦੀ ਸੁਰੱਖਿਆ ਜਾਂਚ ਰਹੇ ਹਾਂ...", "ml-IN": "സൈറ്റ് സുരക്ഷ പരിശോധിക്കുന്നു..." },
  "SITE SAFETY": { "hi-IN": "साइट सुरक्षा", "ta-IN": "தளப் பாதுகாப்பு", "te-IN": "సైట్ భద్రత", "kn-IN": "ಸೈಟ್ ಸುರಕ್ಷತೆ", "mr-IN": "साइट सुरक्षा", "gu-IN": "સાઇટ સુરક્ષા", "bn-IN": "সাইট নিরাপত্তা", "pa-IN": "ਸਾਈਟ ਸੁਰੱਖਿਆ", "ml-IN": "സൈറ്റ് സുരക്ഷ" },
  "Low risk": { "hi-IN": "कम जोखिम", "ta-IN": "குறைந்த ஆபத்து", "te-IN": "తక్కువ ప్రమాదం", "kn-IN": "ಕಡಿಮೆ ಅಪಾಯ", "mr-IN": "कमी जोखीम", "gu-IN": "ઓછું જોખમ", "bn-IN": "কম ঝুঁকি", "pa-IN": "ਘੱਟ ਜੋਖਮ", "ml-IN": "കുറഞ്ഞ അപകടസാധ്യത" },
  "Use caution": { "hi-IN": "सावधानी बरतें", "ta-IN": "எச்சரிக்கையாக இருங்கள்", "te-IN": "జాగ్రత్తగా ఉండండి", "kn-IN": "ಎಚ್ಚರಿಕೆಯಿಂದಿರಿ", "mr-IN": "सावधगिरी बाळगा", "gu-IN": "સાવચેત રહો", "bn-IN": "সতর্ক থাকুন", "pa-IN": "ਸਾਵਧਾਨੀ ਵਰਤੋ", "ml-IN": "ജാഗ്രത പാലിക്കുക" },
  "High risk": { "hi-IN": "उच्च जोखिम", "ta-IN": "அதிக ஆபத்து", "te-IN": "అధిక ప్రమాదం", "kn-IN": "ಹೆಚ್ಚಿನ ಅಪಾಯ", "mr-IN": "उच्च जोखीम", "gu-IN": "ઉચ્ચ જોખમ", "bn-IN": "উচ্চ ঝুঁকি", "pa-IN": "ਉੱਚ ਜੋਖਮ", "ml-IN": "ഉയർന്ന അപകടസാധ്യത" },
  Unknown: { "hi-IN": "अज्ञात", "ta-IN": "தெரியவில்லை", "te-IN": "తెలియదు", "kn-IN": "ತಿಳಿದಿಲ್ಲ", "mr-IN": "अज्ञात", "gu-IN": "અજ્ઞાત", "bn-IN": "অজানা", "pa-IN": "ਅਣਜਾਣ", "ml-IN": "അജ്ഞാതം" },
  "This is a risk assessment, not proof that a site is fake or legitimate.": { "hi-IN": "यह जोखिम आकलन है; इससे साइट के नकली या वैध होने का पक्का प्रमाण नहीं मिलता।", "ta-IN": "இது ஒரு ஆபத்து மதிப்பீடு மட்டுமே; தளம் போலியானது அல்லது உண்மையானது என்பதற்கான உறுதியான ஆதாரம் அல்ல.", "te-IN": "ఇది ప్రమాద అంచనా మాత్రమే; సైట్ నకిలీ లేదా నిజమైనదని నిరూపించదు.", "kn-IN": "ಇದು ಅಪಾಯದ ಮೌಲ್ಯಮಾಪನ ಮಾತ್ರ; ಸೈಟ್ ನಕಲಿ ಅಥವಾ ನಿಜವೆಂಬುದಕ್ಕೆ ಇದು ಪುರಾವೆಯಲ್ಲ.", "mr-IN": "हे जोखीम मूल्यांकन आहे; साइट बनावट किंवा वैध असल्याचा हा पुरावा नाही.", "gu-IN": "આ જોખમનું મૂલ્યાંકન છે; સાઇટ નકલી કે વિશ્વસનીય હોવાનો આ પુરાવો નથી.", "bn-IN": "এটি একটি ঝুঁকি মূল্যায়ন; সাইটটি ভুয়া বা বৈধ—এর প্রমাণ নয়।", "pa-IN": "ਇਹ ਜੋਖਮ ਦਾ ਮੁਲਾਂਕਣ ਹੈ; ਇਹ ਸਾਈਟ ਦੇ ਨਕਲੀ ਜਾਂ ਜਾਇਜ਼ ਹੋਣ ਦਾ ਸਬੂਤ ਨਹੀਂ ਹੈ।", "ml-IN": "ഇത് ഒരു അപകടസാധ്യതാ വിലയിരുത്തൽ മാത്രമാണ്; സൈറ്റ് വ്യാജമോ യഥാർത്ഥമോ എന്നതിന് തെളിവല്ല." },
});

Object.assign(UI_TRANSLATIONS, {
  Step: { "hi-IN": "चरण", "ta-IN": "படி", "te-IN": "దశ", "kn-IN": "ಹಂತ", "mr-IN": "टप्पा", "gu-IN": "પગલું", "bn-IN": "ধাপ", "pa-IN": "ਕਦਮ", "ml-IN": "ഘട്ടം" },
  Field: { "hi-IN": "फ़ील्ड", "ta-IN": "புலம்", "te-IN": "ఫీల్డ్", "kn-IN": "ಕ್ಷೇತ್ರ", "mr-IN": "फील्ड", "gu-IN": "ફીલ્ડ", "bn-IN": "ঘর", "pa-IN": "ਫੀਲਡ", "ml-IN": "ഫീൽഡ്" },
  "Reply with a value for": { "hi-IN": "इसके लिए जानकारी दें", "ta-IN": "இதற்கான மதிப்பைச் சொல்லுங்கள்", "te-IN": "దీనికి విలువ చెప్పండి", "kn-IN": "ಇದಕ್ಕೆ ಮೌಲ್ಯವನ್ನು ತಿಳಿಸಿ", "mr-IN": "यासाठी माहिती द्या", "gu-IN": "આ માટે માહિતી આપો", "bn-IN": "এর জন্য তথ্য দিন", "pa-IN": "ਇਸ ਲਈ ਜਾਣਕਾਰੀ ਦਿਓ", "ml-IN": "ഇതിന് വേണ്ട വിവരം നൽകുക" },
  "Page changed; refreshing before retrying...": { "hi-IN": "पेज बदल गया है; दोबारा कोशिश से पहले नया पेज देख रहे हैं...", "ta-IN": "பக்கம் மாறியுள்ளது; மீண்டும் முயற்சிக்கும் முன் புதுப்பிக்கிறோம்...", "te-IN": "పేజీ మారింది; మళ్లీ ప్రయత్నించే ముందు తాజా పేజీని చూస్తున్నాం...", "kn-IN": "ಪುಟ ಬದಲಾಗಿದೆ; ಮತ್ತೆ ಪ್ರಯತ್ನಿಸುವ ಮೊದಲು ನವೀಕರಿಸುತ್ತಿದ್ದೇವೆ...", "mr-IN": "पृष्ठ बदलले; पुन्हा प्रयत्न करण्यापूर्वी अद्ययावत करत आहोत...", "gu-IN": "પેજ બદલાયું છે; ફરી પ્રયાસ કરતાં પહેલાં નવું પેજ જોઈ રહ્યા છીએ...", "bn-IN": "পৃষ্ঠা বদলেছে; আবার চেষ্টা করার আগে নতুন পৃষ্ঠা দেখছি...", "pa-IN": "ਪੰਨਾ ਬਦਲ ਗਿਆ; ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਤੋਂ ਪਹਿਲਾਂ ਤਾਜ਼ਾ ਕਰ ਰਹੇ ਹਾਂ...", "ml-IN": "പേജ് മാറി; വീണ്ടും ശ്രമിക്കുന്നതിന് മുമ്പ് പുതുക്കുന്നു..." },
});

function isSelectionCommand(text: string): boolean {
  const value = text.toLowerCase().trim();
  return /(?:select|snip|capture|screenshot|crop|highlight).*(?:area|this|that|section|part|region)?|(?:yeh|yah|is|this)\s+(?:select|snip|capture|screenshot)|area\s+(?:select|snip)|select\s+karo/.test(value);
}


const ACTION_SPEECH: Record<string, { filled: string; selected: string; clicked: string; scrolled: string; opened: string }> = {
  "en-IN": { filled: "Filled the %s field.", selected: "Updated the %s selection.", clicked: "Clicked %s.", scrolled: "Scrolled %s.", opened: "Opened the requested page." },
  "hi-IN": { filled: "%s फ़ील्ड भर दिया।", selected: "%s का विकल्प चुन लिया।", clicked: "%s पर क्लिक किया।", scrolled: "%s स्क्रॉल किया।", opened: "मांगा गया पेज खोल दिया।" },
  "ta-IN": { filled: "%s புலத்தை நிரப்பினேன்.", selected: "%s தேர்வை மாற்றினேன்.", clicked: "%s என்பதை அழுத்தினேன்.", scrolled: "%s உருட்டினேன்.", opened: "கோரிய பக்கத்தைத் திறந்தேன்." },
  "te-IN": { filled: "%s ఫీల్డ్‌ను నింపాను.", selected: "%s ఎంపికను మార్చాను.", clicked: "%s పై క్లిక్ చేశాను.", scrolled: "%s స్క్రోల్ చేశాను.", opened: "కోరిన పేజీని తెరిచాను." },
  "kn-IN": { filled: "%s ಕ್ಷೇತ್ರವನ್ನು ಭರ್ತಿ ಮಾಡಿದೆ.", selected: "%s ಆಯ್ಕೆಯನ್ನು ಬದಲಿಸಿದೆ.", clicked: "%s ಕ್ಲಿಕ್ ಮಾಡಿದೆ.", scrolled: "%s ಸ್ಕ್ರಾಲ್ ಮಾಡಿದೆ.", opened: "ಕೋರಿದ ಪುಟವನ್ನು ತೆರೆದಿದ್ದೇನೆ." },
  "mr-IN": { filled: "%s फील्ड भरले.", selected: "%s पर्याय निवडला.", clicked: "%s वर क्लिक केले.", scrolled: "%s स्क्रोल केले.", opened: "मागितलेले पृष्ठ उघडले." },
  "gu-IN": { filled: "%s ફીલ્ડ ભરી દીધું.", selected: "%s વિકલ્પ બદલ્યો.", clicked: "%s પર ક્લિક કર્યું.", scrolled: "%s સ્ક્રોલ કર્યું.", opened: "માગેલું પેજ ખોલ્યું." },
  "bn-IN": { filled: "%s ঘরটি পূরণ করেছি।", selected: "%s বিকল্পটি বদলেছি।", clicked: "%s-এ ক্লিক করেছি।", scrolled: "%s স্ক্রল করেছি।", opened: "অনুরোধ করা পৃষ্ঠাটি খুলেছি।" },
  "pa-IN": { filled: "%s ਫੀਲਡ ਭਰ ਦਿੱਤਾ।", selected: "%s ਵਿਕਲਪ ਬਦਲਿਆ।", clicked: "%s 'ਤੇ ਕਲਿੱਕ ਕੀਤਾ।", scrolled: "%s ਸਕ੍ਰੋਲ ਕੀਤਾ।", opened: "ਮੰਗਿਆ ਪੰਨਾ ਖੋਲ੍ਹ ਦਿੱਤਾ।" },
  "ml-IN": { filled: "%s ഫീൽഡ് പൂരിപ്പിച്ചു.", selected: "%s തിരഞ്ഞെടുപ്പ് മാറ്റി.", clicked: "%s ക്ലിക്ക് ചെയ്തു.", scrolled: "%s സ്ക്രോൾ ചെയ്തു.", opened: "ആവശ്യപ്പെട്ട പേജ് തുറന്നു." },
};

function localizedActionSpeech(action: PlannerAction, snapshot: PageSnapshot, languageCode: string): string {
  const speech = ACTION_SPEECH[languageCode] || ACTION_SPEECH["en-IN"];
  if (action.action === "navigate") return speech.opened;
  if (action.action === "scroll") return speech.scrolled.replace("%s", action.direction);
  if (action.action === "click" || action.action === "type" || action.action === "select") {
    const target = snapshot.interactiveElements.find((element) => element.id === action.id);
    const label = target?.label?.trim() || "field";
    if (action.action === "click") return speech.clicked.replace("%s", label);
    if (action.action === "select") return speech.selected.replace("%s", label);
    return speech.filled.replace("%s", label);
  }
  return action.action === "done" ? action.summary : action.action === "ask_user" ? action.question : "";
}

function resolveSpeechLanguage(languageCode: string, text: string): string {
  if (languageCode !== "indic-auto") return languageCode;
  if (/\p{Script=Tamil}/u.test(text)) return "ta-IN";
  if (/\p{Script=Telugu}/u.test(text)) return "te-IN";
  if (/\p{Script=Kannada}/u.test(text)) return "kn-IN";
  if (/\p{Script=Bengali}/u.test(text)) return "bn-IN";
  if (/\p{Script=Gurmukhi}/u.test(text)) return "pa-IN";
  if (/\p{Script=Malayalam}/u.test(text)) return "ml-IN";
  if (/\p{Script=Gujarati}/u.test(text)) return "gu-IN";
  if (/\p{Script=Devanagari}/u.test(text)) return "hi-IN";
  return "en-IN";
}

const ACTION_TAG_TRANSLATIONS: Record<string, Record<string, string>> = {
  "hi-IN": { click: "क्लिक", type: "लिखें", select: "चुनें", scroll: "स्क्रॉल", navigate: "पेज खोलें", ask_user: "पूछें", done: "पूरा" },
  "ta-IN": { click: "அழுத்து", type: "உள்ளிடு", select: "தேர்வு", scroll: "உருட்டு", navigate: "பக்கம் திற", ask_user: "கேள்", done: "முடிந்தது" },
  "te-IN": { click: "క్లిక్", type: "నమోదు", select: "ఎంపిక", scroll: "స్క్రోల్", navigate: "పేజీ తెరువు", ask_user: "అడుగు", done: "పూర్తి" },
  "kn-IN": { click: "ಕ್ಲಿಕ್", type: "ನಮೂದಿಸಿ", select: "ಆಯ್ಕೆ", scroll: "ಸ್ಕ್ರಾಲ್", navigate: "ಪುಟ ತೆರೆಯಿರಿ", ask_user: "ಕೇಳಿ", done: "ಪೂರ್ಣ" },
  "mr-IN": { click: "क्लिक", type: "भरा", select: "निवडा", scroll: "स्क्रोल", navigate: "पृष्ठ उघडा", ask_user: "विचारा", done: "पूर्ण" },
  "gu-IN": { click: "ક્લિક", type: "ભરો", select: "પસંદ કરો", scroll: "સ્ક્રોલ", navigate: "પેજ ખોલો", ask_user: "પૂછો", done: "પૂર્ણ" },
  "bn-IN": { click: "ক্লিক", type: "লিখুন", select: "বেছে নিন", scroll: "স্ক্রল", navigate: "পৃষ্ঠা খুলুন", ask_user: "জিজ্ঞাসা", done: "সম্পন্ন" },
  "pa-IN": { click: "ਕਲਿੱਕ", type: "ਭਰੋ", select: "ਚੁਣੋ", scroll: "ਸਕ੍ਰੋਲ", navigate: "ਪੰਨਾ ਖੋਲ੍ਹੋ", ask_user: "ਪੁੱਛੋ", done: "ਪੂਰਾ" },
  "ml-IN": { click: "ക്ലിക്ക്", type: "നൽകുക", select: "തിരഞ്ഞെടുക്കുക", scroll: "സ്ക്രോൾ", navigate: "പേജ് തുറക്കുക", ask_user: "ചോദിക്കുക", done: "പൂർത്തിയായി" },
};

function cropCapturedImage(dataUrl: string, rect: { x: number; y: number; width: number; height: number }, viewportWidth: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = image.width / Math.max(viewportWidth, 1);
      const sx = Math.max(0, Math.round(rect.x * scale));
      const sy = Math.max(0, Math.round(rect.y * scale));
      const sw = Math.min(image.width - sx, Math.max(1, Math.round(rect.width * scale)));
      const sh = Math.min(image.height - sy, Math.max(1, Math.round(rect.height * scale)));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");
      if (!context) { reject(new Error("Could not prepare the selected image.")); return; }
      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve(canvas.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("Could not process the selected image."));
    image.src = dataUrl;
  });
}

function migrateRetiredGeminiModel(settings: SettingsState): SettingsState {
  if (settings.llmProvider === "gemini" && RETIRED_GEMINI_MODELS.has(settings.llmModel)) {
    return { ...settings, llmModel: DEFAULT_GEMINI_MODEL };
  }
  return settings;
}

export const App: React.FC = () => {
  // Agent state
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusText, setStatusText] = useState<string>("Ready");
  const [voiceSessionActive, setVoiceSessionActive] = useState(false);
  const [showMicPermissionHelp, setShowMicPermissionHelp] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [activeTabTitle, setActiveTabTitle] = useState<string>("");
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState<string>("");
  const [steps, setSteps] = useState<StepLogEntry[]>([]);
  const [currentPrompt, setCurrentPrompt] = useState<string>("");
  const [pendingConfirmationAction, setPendingConfirmationAction] = useState<PlannerAction | null>(null);
  const [confirmationMessage, setConfirmationMessage] = useState<string>("");
  const [taskCards, setTaskCards] = useState<TaskCardState[]>([]);
  const [globalGuidance, setGlobalGuidance] = useState<Guidance | null>(null);
  const [activeConfirmationTaskId, setActiveConfirmationTaskId] = useState<string | null>(null);
  const [activeQuestionTaskId, setActiveQuestionTaskId] = useState<string | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [snips, setSnips] = useState<SnipContext[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [siteChatMessages, setSiteChatMessages] = useState<ChatMessage[]>([]);
  const [siteSafety, setSiteSafety] = useState<SiteSafetyResult | null>(null);
  const [siteSafetyLoading, setSiteSafetyLoading] = useState(false);
  const [siteChat, setSiteChat] = useState<SiteChatState>({
    status: "idle",
    startUrl: "",
    siteId: "",
    jobId: "",
    pagesIndexed: 0,
    message: "",
  });

  // Settings modal
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settings, setSettings] = useState<SettingsState>(DEFAULT_SETTINGS);
  const translate = (english: string, hindi: string) => {
    const language = resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript) as InterfaceLanguage;
    return UI_TRANSLATIONS[english]?.[language] || (language === "hi-IN" ? hindi : english);
  };

  // Refs for tracking active objects
  const micSessionRef = useRef<MicrophoneSession>(new MicrophoneSession());
  const gnaniWsRef = useRef<GnaniPrismaWebSocketClient | null>(null);
  const isStoppedRef = useRef<boolean>(false);
  const stepsRef = useRef<StepLogEntry[]>([]);
  const taskGoalRef = useRef<string | null>(null);
  const conversationRef = useRef<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const awaitingUserReplyRef = useRef(false);
  const formFillRef = useRef<FormFillSession | null>(null);
  const voiceSessionActiveRef = useRef(false);
  const voiceTurnProcessingRef = useRef(false);
  const requestQueueRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRequestKeysRef = useRef(new Set<string>());
  const requestQueueGenerationRef = useRef(0);
  const taskContextsRef = useRef(new Map<string, TaskRunnerContext>());
  const taskViewsRef = useRef(new Map<string, TaskCardState>());
  const confirmationQueueRef = useRef<string[]>([]);
  const questionQueueRef = useRef<string[]>([]);
  const taskRunGenerationRef = useRef(0);
  const activeTaskIdsRef = useRef<string[]>([]);
  const summarySpokenGenerationRef = useRef(0);
  const decompositionNoticeRef = useRef<string | null>(null);
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());
  const voiceListenGenerationRef = useRef(0);
  const voiceTurnHandlerRef = useRef<(text: string) => Promise<void>>(async () => {});
  const startVoiceListeningRef = useRef<() => Promise<void>>(async () => {});
  const siteIndexPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const siteChatRef = useRef<SiteChatState>(siteChat);
  const siteChatRunRef = useRef(0);
  const siteChatTabRef = useRef<number | null>(null);
  const siteSafetyRunRef = useRef(0);
  stepsRef.current = steps;
  siteChatRef.current = siteChat;

  const publishTaskCard = (taskId: string, patch: Partial<TaskCardState>) => {
    const current = taskViewsRef.current.get(taskId);
    if (!current) return;
    const next = { ...current, ...patch };
    taskViewsRef.current.set(taskId, next);
    setTaskCards(Array.from(taskViewsRef.current.values()));
  };

  const showNextConfirmation = () => {
    const next = confirmationQueueRef.current[0] || null;
    setActiveConfirmationTaskId(next);
    const context = next ? taskContextsRef.current.get(next) : null;
    setPendingConfirmationAction(context?.pendingConfirmation?.action || null);
    setConfirmationMessage(context?.pendingConfirmation?.message || "");
  };

  const enqueueConfirmation = (taskId: string) => {
    if (taskId && !confirmationQueueRef.current.includes(taskId)) confirmationQueueRef.current.push(taskId);
    showNextConfirmation();
  };

  const advanceConfirmationQueue = () => {
    confirmationQueueRef.current = confirmationQueueRef.current.slice(1);
    showNextConfirmation();
  };

  const showNextQuestion = () => {
    const next = questionQueueRef.current[0] || null;
    setActiveQuestionTaskId(next);
    if (next) setQuestionAnswer("");
  };

  const enqueueQuestion = (taskId: string) => {
    if (taskId && !questionQueueRef.current.includes(taskId)) questionQueueRef.current.push(taskId);
    showNextQuestion();
  };

  const advanceQuestionQueue = () => {
    questionQueueRef.current = questionQueueRef.current.slice(1);
    showNextQuestion();
  };

  const resetSiteChatSession = () => {
    if (siteIndexPollRef.current) clearTimeout(siteIndexPollRef.current);
    siteIndexPollRef.current = null;
    siteChatRunRef.current += 1;
    siteChatTabRef.current = null;
    setSiteChat({ status: "idle", startUrl: "", siteId: "", jobId: "", pagesIndexed: 0, message: "" });
    setSiteChatMessages([]);
  };

  const resetSiteSafety = () => {
    siteSafetyRunRef.current += 1;
    setSiteSafety(null);
    setSiteSafetyLoading(false);
  };

  // Load saved settings from chrome.storage.local
  useEffect(() => {
    chrome.storage.local.get("browseVoiceSettings", (result) => {
      if (result.browseVoiceSettings) {
        const savedSettings = result.browseVoiceSettings as Partial<SettingsState>;
        const mergedSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
        const migratedSettings = migrateRetiredGeminiModel(mergedSettings);
        setSettings(migratedSettings);
        setStatusText(UI_TRANSLATIONS.Ready?.[migratedSettings.languageCode as InterfaceLanguage] || "Ready");
        if (migratedSettings.llmModel !== savedSettings.llmModel) {
          chrome.storage.local.set({ browseVoiceSettings: migratedSettings });
        }
      } else {
        const initialSettings = migrateRetiredGeminiModel(DEFAULT_SETTINGS);
        setSettings(initialSettings);
        setStatusText(UI_TRANSLATIONS.Ready?.[initialSettings.languageCode as InterfaceLanguage] || "Ready");
        chrome.storage.local.set({ browseVoiceSettings: initialSettings });
      }
    });

    // Detect active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (tab?.id) {
        setActiveTabId(tab.id);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
      }
    });

    // Listen for tab activation changes
    const onTabActivated = (activeInfo: chrome.tabs.OnActivatedInfo) => {
      if (siteChatRef.current.status !== "idle" && siteChatTabRef.current !== null && siteChatTabRef.current !== activeInfo.tabId) {
        resetSiteChatSession();
      }
      setActiveTabId(activeInfo.tabId);
      resetSiteSafety();
      chrome.tabs.get(activeInfo.tabId, (t) => {
        if (t?.title) setActiveTabTitle(t.title);
        if (t?.url !== undefined) setActiveTabUrl(t.url || "");
      });
    };

    // Also update URL when tab updates (e.g. navigation within same tab)
    const onTabUpdated = (tabId: number, _info: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => {
      if (tab.active) {
        if (siteChatRef.current.status !== "idle" && siteChatTabRef.current === tabId && tab.url && tab.url !== siteChatRef.current.startUrl) {
          resetSiteChatSession();
        }
        setActiveTabId(tabId);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
        resetSiteSafety();
      }
    };

    const onTabRemoved = (tabId: number) => {
      for (const [taskId, context] of taskContextsRef.current.entries()) {
        if (context.tabId !== tabId) continue;
        stopAgentTask(context);
        const guidance = buildGuidance("tab_closed", {
          translate,
          taskLabel: taskViewsRef.current.get(taskId)?.label,
          tabTitle: taskViewsRef.current.get(taskId)?.tabTitle,
          error: "The controlled tab was closed.",
        });
        applyTaskGuidance(context, guidance, "failed");
        publishTaskCard(taskId, { status: "failed", error: guidance.whatHappened, currentStep: guidance.title, guidance });
        taskContextsRef.current.delete(taskId);
      }
      if (activeTabId === tabId) {
        setActiveTabId(null);
        setActiveTabTitle("");
        setActiveTabUrl("");
      }
    };

    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    return () => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
      chrome.tabs.onRemoved.removeListener(onTabRemoved);
    };
  }, [activeTabId]);

  const saveSettings = (newSettings: SettingsState) => {
    setSettings(newSettings);
    chrome.storage.local.set({ browseVoiceSettings: newSettings });
    setSettingsOpen(false);
  };

  /**
   * Emergency Stop ("ruko" / "stop" or Stop button).
   * Mandatory Rule: Cancels speech and all pending actions immediately.
   */
  const handleEmergencyStop = useCallback(() => {
    isStoppedRef.current = true;
    requestQueueGenerationRef.current += 1;
    taskRunGenerationRef.current += 1;
    stopAgentTasks(taskContextsRef.current.values());
    taskContextsRef.current.clear();
    confirmationQueueRef.current = [];
    questionQueueRef.current = [];
    setActiveConfirmationTaskId(null);
    setActiveQuestionTaskId(null);
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    setTaskCards((previous) => previous.map((task) => ({ ...task, status: "stopped", currentStep: translate("Stopped", "रोक दिया गया") })));
    micSessionRef.current.stop();
    gnaniWsRef.current?.disconnect();
    stopAllSpeech();
    siteChatRunRef.current += 1;
    siteChatTabRef.current = null;
    if (siteIndexPollRef.current) {
      clearTimeout(siteIndexPollRef.current);
      siteIndexPollRef.current = null;
    }
    voiceSessionActiveRef.current = false;
    setVoiceSessionActive(false);
    voiceListenGenerationRef.current += 1;

    setStatus("stopped");
    setStatusText(translate("Stopped", "रोक दिया गया"));
    taskGoalRef.current = null;
    conversationRef.current = [];
    awaitingUserReplyRef.current = false;
    formFillRef.current = null;

    // Notify every controlled tab to remove its indicator.
    for (const task of taskViewsRef.current.values()) {
      if (task.tabId !== null) chrome.tabs.sendMessage(task.tabId, { type: "BV_DEACTIVATE_AGENT" }).catch(() => {});
    }
  }, [activeTabId, translate]);

  const sendTabMessage = async <T,>(tabId: number, message: Record<string, unknown>): Promise<T> => {
    try {
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (firstError) {
      // Navigation can destroy the content-script port. Ask the service worker
      // to inject the listener into the current document before retrying once.
      const connection = await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId }).catch(() => null);
      if (!connection?.ok) {
        const errorText = firstError instanceof Error ? firstError.message : "The page changed before Browse Voice could connect.";
        throw new Error(/receiving end|message channel|back.forward cache|bfcache/i.test(errorText)
          ? "The page changed before Browse Voice could respond. Please try again."
          : errorText);
      }
      try {
        return await chrome.tabs.sendMessage(tabId, message) as T;
      } catch (secondError) {
        const errorText = secondError instanceof Error ? secondError.message : "The page changed before Browse Voice could respond.";
        throw new Error(/receiving end|message channel|back.forward cache|bfcache/i.test(errorText)
          ? "The page changed before Browse Voice could respond. Please try again."
          : errorText);
      }
    }
  };

  /**
   * Query snapshot from content script
   */
  const fetchPageSnapshot = async (tabId: number): Promise<PageSnapshot> => {
    const response = await sendTabMessage<{ ok?: boolean; snapshot?: PageSnapshot; error?: string }>(tabId, { type: "BV_GET_SNAPSHOT" });
    if (!response || !response.ok || !response.snapshot) {
      throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
    }
    return response.snapshot as PageSnapshot;
  };

  /**
   * Helper to speak using Gnani Timbre with Hindi / Indic language support
   */
  const speakStatus = async (text: string, languageCode = resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript)) => {
    if (isStoppedRef.current || !text) return;
    const queuedSpeech = ttsQueueRef.current.catch(() => {}).then(async () => {
      if (isStoppedRef.current) return;
      setStatus("speaking");
      setStatusText(text);

      const gnaniConfig: GnaniConfig = {
        apiKey: settings.gnaniApiKey,
        languageCode,
        ttsVoice: "Nalini",
        ttsModel: "timbre-v2.5",
      };

      await speakWithTimbre(text, gnaniConfig);
      if (!isStoppedRef.current) setStatus("idle");
    });
    ttsQueueRef.current = queuedSpeech.catch(() => {});
    await queuedSpeech;
  };

  const askNextFormField = async () => {
    const session = formFillRef.current;
    if (!session) return;

    // Skip fields whose answers are already known in this session.
    while (session.index < session.fields.length) {
      const candidate = session.fields[session.index];
      if (candidate.knownValue && !session.answers.has(candidate.fingerprint)) {
        session.answers.set(candidate.fingerprint, candidate.knownValue);
        const applied = await submitFormFieldAnswer(candidate.knownValue, { fromKnownValue: true });
        if (applied) return;
      }
      break;
    }

    const field = session.fields[session.index];
    if (!field) return;
    const question = field.askPrompt || `${field.question || field.label}?`;
    setStatus("idle");
    const modeNote = session.plannerMode === "heuristic" ? " · heuristic Q&A" : "";
    setStatusText(`${translate("Field", "फ़ील्ड")} ${session.index + 1} / ${session.fields.length}: ${field.question || field.label}${modeNote}`);
    await speakStatus(question);
    setStatusText(`${translate("Reply with a value for", "इसके लिए जानकारी दें")}: ${field.question || field.label}`);
  };

  const submitFormFieldAnswer = async (answer: string, options?: { fromKnownValue?: boolean }) => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return false;

    const llmConfig = {
      provider: settings.llmProvider,
      apiKey: settings.llmApiKey,
      endpoint: settings.llmEndpoint,
      model: settings.llmModel,
    } as const;

    setStatus("thinking");
    setStatusText(`${translate("Filling", "भर रहे हैं:")} ${field.question || field.label}...`);
    try {
      let resolution = resolveFormAnswer(field, answer);
      if (resolution.status === "empty") {
        setStatus("idle");
        setStatusText(resolution.message || `Please answer for: ${field.question || field.label}`);
        return true;
      }
      if (resolution.status === "ambiguous" || resolution.status === "invalid") {
        resolution = await resolveAmbiguousAnswerWithLLM(
          llmConfig,
          field,
          answer,
          resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || ""),
        );
      }
      if (resolution.status !== "matched") {
        setStatus("idle");
        setStatusText(resolution.message || `Please clarify: ${field.question || field.label}`);
        return true;
      }

      let value = resolution.value || "";
      const freshSnapshot = await fetchPageSnapshot(session.tabId);
      const element = findFormField(freshSnapshot, field, field.kind === "radio" ? value : undefined);
      if (!element && (field.kind === "radio" || field.kind === "select" || field.kind === "combobox")) {
        setStatus("idle");
        setStatusText(`Choose one of these options for ${field.question || field.label}: ${field.options?.join(", ") || ""}`);
        return true;
      }
      if (!element) throw new Error(`I can no longer find the ${field.question || field.label} field. The page may have changed — try again.`);
      if (element.interactable === false) {
        throw new Error(`The ${field.question || field.label} field is not interactable right now.`);
      }

      if (field.kind === "text" && /\p{Script=Devanagari}/u.test(value)) {
        const normalizedField = `${field.question} ${field.label} ${field.name || ""} ${field.type || ""}`.toLowerCase();
        if (/email|e-mail|url|website|website address/.test(normalizedField)) {
          setStatus("idle");
          setStatusText("यह जानकारी अंग्रेज़ी अक्षरों में टाइप करें, ताकि ईमेल या लिंक सही रहे।");
          return true;
        }
        const conversionMode = field.type === "date" || /\b(date|dob|birth)\b/.test(normalizedField)
          ? "date"
          : /\b(first.?name|given.?name|last.?name|surname|family.?name|full.?name|name)\b/.test(normalizedField)
            ? "transliterate"
            : "translate";
        try {
          value = await convertFormAnswerToEnglish(llmConfig, value, conversionMode);
          if (/\p{Script=Devanagari}/u.test(value)) {
            throw new Error("The converted value still contains Devanagari text.");
          }
          resolution = { ...resolution, value, matchedOption: resolution.matchedOption };
        } catch (conversionError) {
          console.warn("Hindi form answer conversion failed:", conversionError);
          setStatus("idle");
          setStatusText("मैं इसे अंग्रेज़ी में नहीं बदल पाया। कृपया जवाब अंग्रेज़ी अक्षरों में टाइप करें और फिर भेजें।");
          return true;
        }
      }

      const candidate = buildFillAction(field, element, { ...resolution, value });
      let response: { ok: boolean; error?: string; freshSnapshot?: PageSnapshot; verified?: boolean; observedValue?: string } | null = null;
      if (candidate) {
        const validation = validatePlannerAction(candidate);
        if (!validation.valid) throw new Error(validation.error);
        const safety = inspectActionSafety(validation.action, freshSnapshot);
        if (!safety.permitted) throw new Error(safety.reason || "Safety blocked this field.");
        if (safety.requiresConfirmation) {
          // Never auto-submit. Skip consequential controls and continue.
          session.skippedManualCount += 1;
          await speakStatus(`I left ${field.question || field.label} unchanged because it needs your explicit confirmation. I will continue to the next field.`);
        } else {
          response = await sendTabMessage<{ ok: boolean; error?: string; freshSnapshot?: PageSnapshot; verified?: boolean; observedValue?: string }>(session.tabId, {
            type: "BV_EXECUTE_ACTION",
            action: validation.action,
          });
          if (!response?.ok) throw new Error(response?.error || `Could not fill ${field.question || field.label}.`);

          const verifySnapshot = (response.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
          const filledElement = findFormField(verifySnapshot, field, field.kind === "radio" ? value : undefined)
            || verifySnapshot.interactiveElements.find((item) => item.id === element.id);
          const verification = verifyFilledValue(filledElement, field, { ...resolution, value });
          if (!verification.ok && response.verified === false) {
            throw new Error(verification.reason || `I could not verify that “${field.question || field.label}” was filled correctly.`);
          }
          if (!verification.ok) {
            // Soft retry once with a fresh observation when executor claimed success but snapshot disagrees.
            const retry = await sendTabMessage<{ ok: boolean; error?: string; freshSnapshot?: PageSnapshot; verified?: boolean }>(session.tabId, {
              type: "BV_EXECUTE_ACTION",
              action: validation.action,
            });
            const retrySnapshot = (retry?.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
            const retryElement = findFormField(retrySnapshot, field, field.kind === "radio" ? value : undefined)
              || retrySnapshot.interactiveElements.find((item) => item.id === element.id);
            const retryVerification = verifyFilledValue(retryElement, field, { ...resolution, value });
            if (!retryVerification.ok) {
              throw new Error(retryVerification.reason || `Verification failed for “${field.question || field.label}”.`);
            }
            response = { ...retry, freshSnapshot: retrySnapshot };
          }

          const stepNumber = stepsRef.current.length + 1;
          const fieldOutcome = localizedActionSpeech(validation.action, freshSnapshot, resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript));
          setSteps((previous) => [...previous, {
            stepNumber,
            action: validation.action,
            status: "success",
            spokenSummary: fieldOutcome,
            timestamp: Date.now(),
          }]);
          if (!options?.fromKnownValue) await speakStatus(fieldOutcome);
        }
      }

      session.completed.add(field.fingerprint);
      session.answers.set(field.fingerprint, value);

      const updatedSnapshot = (response?.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
      const refreshed = collectFormFields(updatedSnapshot);
      const merged = mergeFormSessionFields(session, refreshed);
      formFillRef.current = merged;

      if (merged.fields.length === 0) {
        merged.awaitingSubmitApproval = true;
        const skippedMessage = merged.skippedManualCount > 0
          ? "The supported fields are filled. Fill any sensitive, file, or protected fields yourself, then review the form. Say when you want me to submit — I will not submit without your approval."
          : "The visible fields are filled. Please review the form. I did not submit it. Say submit only if you want me to send it.";
        formFillRef.current = null;
        taskGoalRef.current = null;
        conversationRef.current = [];
        awaitingUserReplyRef.current = false;
        await speakStatus(skippedMessage);
        setStatus("idle");
        setStatusText(translate("Form filled. Review before submitting.", "फॉर्म भर दिया गया है। सबमिट करने से पहले जांचें।"));
      } else {
        await askNextFormField();
      }
    } catch (error) {
      setStatus("idle");
      setStatusText(error instanceof Error ? error.message : translate("I could not fill that field.", "मैं यह फील्ड नहीं भर सका।"));
    }
    return true;
  };

  const handleUserRequest = async (text: string) => {
    if (formFillRef.current && await submitFormFieldAnswer(text)) return;
    if (isCurrentPageQuestion(text)) {
      if (snips.length > 0) await answerFromSnips(text);
      else await answerFromPage(text);
      return;
    }
    if (siteChatRef.current.status === "ready" && siteChatRef.current.siteId) {
      await answerFromSite(text);
      return;
    }
    await runAgentLoop(text);
  };

  const handleUserRequestSafely = async (text: string) => {
    const requestKey = text.trim().toLocaleLowerCase().replace(/\s+/g, " ");
    if (!requestKey || queuedRequestKeysRef.current.has(requestKey)) return;
    queuedRequestKeysRef.current.add(requestKey);
    const generation = requestQueueGenerationRef.current;
    const queuedRun = requestQueueRef.current.then(async () => {
      if (generation !== requestQueueGenerationRef.current) {
        queuedRequestKeysRef.current.delete(requestKey);
        return;
      }
      try {
        await handleUserRequest(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Browse Voice could not complete that request.";
        setStatus("idle");
        setStatusText(message);
      } finally {
        queuedRequestKeysRef.current.delete(requestKey);
      }
    });
    requestQueueRef.current = queuedRun.catch(() => {
      queuedRequestKeysRef.current.delete(requestKey);
    });
    await queuedRun;
  };

  /**
   * Checks whether the current tab URL is a restricted Chrome-internal page
   * where content scripts cannot be injected.
   */
  const isRestrictedPage = (url: string | undefined): boolean => {
    if (!url) return true;
    return (
      !/^https?:\/\//i.test(url) ||
      url.startsWith("chrome://") ||
      url.startsWith("chrome-extension://") ||
      url.startsWith("about:") ||
      url.startsWith("edge://") ||
      url === "chrome://newtab/" ||
      url === "about:blank"
    );
  };

  /**
   * Tries to resolve a plain "open X" / "navigate to X" intent directly
   * without needing Gemini, for use when on a restricted page.
   * Returns a URL string or null.
   */
  const resolveDirectNavigationIntent = (request: string): string | null => {
    const r = request.toLowerCase().trim();

    // Patterns: "open X", "go to X", "navigate to X", "X kholna", "X kholo"
    const patterns = [
      /^(?:open|go\s+to|navigate\s+to|take\s+me\s+to|visit)\s+(.+)$/i,
      /^(.+?)\s+(?:kholo|kholna|khollo|open\s+karo|open\s+kar)$/i,
    ];

    let siteName: string | null = null;
    for (const pat of patterns) {
      const m = r.match(pat);
      if (m) { siteName = m[1].trim(); break; }
    }

    if (!siteName) return null;

    // If it already looks like a URL, use it directly
    if (/^https?:\/\//i.test(siteName)) return siteName;
    if (/\.[a-z]{2,}(\/|$)/i.test(siteName)) return `https://${siteName}`;

    // Common site name → URL mapping
    const siteMap: Record<string, string> = {
      leetcode: "https://leetcode.com",
      youtube: "https://youtube.com",
      google: "https://google.com",
      gmail: "https://mail.google.com",
      github: "https://github.com",
      stackoverflow: "https://stackoverflow.com",
      "stack overflow": "https://stackoverflow.com",
      twitter: "https://twitter.com",
      x: "https://x.com",
      facebook: "https://facebook.com",
      instagram: "https://instagram.com",
      linkedin: "https://linkedin.com",
      amazon: "https://amazon.in",
      flipkart: "https://flipkart.com",
      netflix: "https://netflix.com",
      spotify: "https://spotify.com",
      reddit: "https://reddit.com",
      whatsapp: "https://web.whatsapp.com",
      maps: "https://maps.google.com",
      "google maps": "https://maps.google.com",
      drive: "https://drive.google.com",
      "google drive": "https://drive.google.com",
      docs: "https://docs.google.com",
      sheets: "https://sheets.google.com",
      irctc: "https://irctc.co.in",
      paytm: "https://paytm.com",
      swiggy: "https://swiggy.com",
      zomato: "https://zomato.com",
      chatgpt: "https://chatgpt.com",
      "chat gpt": "https://chatgpt.com",
      gemini: "https://gemini.google.com",
      notion: "https://notion.so",
      figma: "https://figma.com",
      canva: "https://canva.com",
    };

    const normalized = siteName.toLowerCase().replace(/\s+/g, " ");
    if (siteMap[normalized]) return siteMap[normalized];

    // Unknown site names are intentionally left to the planner; never invent a
    // navigation target from untrusted speech.
    return null;
  };

  const selectArea = async () => {
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    setStatus("thinking");
    setStatusText(translate("Select an area on the page...", "पेज पर क्षेत्र चुनें..."));

    try {
      let selectionResponse: { ok?: boolean; selection?: { rect: { x: number; y: number; width: number; height: number }; viewportWidth: number; text: string; elements: string[]; title: string; url: string }; error?: string };
      selectionResponse = await sendTabMessage<{ ok?: boolean; selection?: { rect: { x: number; y: number; width: number; height: number }; viewportWidth: number; text: string; elements: string[]; title: string; url: string }; error?: string }>(activeTabId, { type: "BV_START_SNIP_SELECTION" });

      if (!selectionResponse?.ok || !selectionResponse.selection) {
        if (selectionResponse?.error === "Selection cancelled.") {
          setStatus("idle");
          setStatusText(translate("Ready", "तैयार"));
          return;
        }
        throw new Error(selectionResponse?.error || "Selection could not be completed.");
      }

      const capture = await chrome.runtime.sendMessage({
        type: "BV_CAPTURE_VISIBLE_TAB",
        windowId: (await chrome.tabs.get(activeTabId)).windowId,
      });
      if (!capture?.ok || !capture.dataUrl) throw new Error(capture?.error || "Could not capture the selected page.");

      const croppedImage = await cropCapturedImage(capture.dataUrl, selectionResponse.selection.rect, selectionResponse.selection.viewportWidth);
      const newSnip: SnipContext = {
        id: `snip-${Date.now()}`,
        imageDataUrl: croppedImage,
        text: selectionResponse.selection.text,
        elements: selectionResponse.selection.elements,
        title: selectionResponse.selection.title,
        url: selectionResponse.selection.url,
      };
      setSnips((previous) => [...previous, newSnip].slice(-4));
      setStatus("idle");
      setStatusText(translate("Selected area added", "चयनित क्षेत्र जोड़ दिया गया है"));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Selection failed.";
      if (message !== "Selection cancelled." && message !== "Selection was too small.") {
        setStatusText(message);
        alert(message);
      } else {
        setStatus("idle");
        setStatusText(translate("Ready", "तैयार"));
      }
    }
  };

  const siteChatConfig = () => ({
    endpoint: settings.siteChatEndpoint,
    apiKey: settings.siteChatApiKey,
    maxPages: settings.siteChatMaxPages,
  });

  const updateSiteIndexProgress = (progress: SiteIndexProgress) => {
    setSiteChat((previous) => ({
      ...previous,
      status: progress.status,
      siteId: progress.siteId || previous.siteId,
      jobId: progress.jobId || previous.jobId,
      pagesIndexed: progress.pagesIndexed ?? previous.pagesIndexed,
      totalPages: progress.totalPages ?? previous.totalPages,
      message: progress.error || progress.message || previous.message,
    }));
  };

  const pollSiteIndex = async (jobId: string, knownSiteId = "", runId = siteChatRunRef.current): Promise<void> => {
    if (runId !== siteChatRunRef.current) return;
    try {
      const progress = await getSiteIndexProgress(siteChatConfig(), jobId);
      if (runId !== siteChatRunRef.current) return;
      updateSiteIndexProgress(progress);

      if (progress.status === "ready") {
        if (!progress.siteId && !knownSiteId && !siteChatRef.current.siteId) {
          setSiteChat((previous) => ({ ...previous, status: "failed", message: "Indexing finished without a site ID." }));
          setStatus("idle");
          setStatusText(translate("Site index is incomplete", "साइट इंडेक्स अधूरा है"));
          return;
        }
        setStatus("idle");
        setStatusText(translate("Site ready", "साइट तैयार है"));
        return;
      }
      if (progress.status === "failed") {
        setStatus("idle");
        setStatusText(progress.error || progress.message || translate("Site indexing failed", "साइट इंडेक्सिंग विफल रही"));
        return;
      }

      setStatus("executing");
      setStatusText(`${translate("Indexing site...", "साइट इंडेक्स हो रही है...")} ${progress.pagesIndexed || 0}${progress.totalPages ? `/${progress.totalPages}` : ""} ${translate("pages", "पेज")}`);
      siteIndexPollRef.current = setTimeout(() => {
        void pollSiteIndex(jobId, knownSiteId || progress.siteId || siteChatRef.current.siteId, runId);
      }, 1200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check site indexing progress.";
      setSiteChat((previous) => ({ ...previous, status: "failed", message }));
      setStatus("idle");
      setStatusText(translate("Site indexing failed", "साइट इंडेक्सिंग विफल रही"));
    }
  };

  const startSiteChat = async () => {
    if (!activeTabUrl || isRestrictedPage(activeTabUrl)) {
      setStatus("idle");
      setStatusText(translate("Open a normal website first", "पहले सामान्य वेबसाइट खोलें"));
      return;
    }
    if (!settings.siteChatEndpoint.trim()) {
      setStatus("idle");
      setStatusText(translate("Add the Site knowledge API endpoint in Settings", "सेटिंग्स में साइट नॉलेज API endpoint जोड़ें"));
      setSettingsOpen(true);
      return;
    }
    if (siteChatRef.current.status === "queued" || siteChatRef.current.status === "crawling" || siteChatRef.current.status === "processing") return;

    if (siteIndexPollRef.current) clearTimeout(siteIndexPollRef.current);
    resetSiteSafety();
    const runId = ++siteChatRunRef.current;
    siteChatTabRef.current = activeTabId;
    setSnips([]);
    setSiteChatMessages([]);
    setSiteChat({
      status: "queued",
      startUrl: activeTabUrl,
      siteId: "",
      jobId: "",
      pagesIndexed: 0,
      message: "Starting crawler...",
    });
    setStatus("executing");
    setStatusText(translate("Starting site crawler...", "साइट क्रॉलर शुरू हो रहा है..."));

    try {
      const started = await startSiteIndexing(siteChatConfig(), activeTabUrl);
      setSiteChat((previous) => ({
        ...previous,
        status: started.status,
        siteId: started.siteId || "",
        jobId: started.jobId,
        pagesIndexed: started.pagesIndexed || 0,
        totalPages: started.totalPages,
        message: started.message || "Crawler is building the site knowledge base.",
      }));
      if (started.status === "ready" && started.siteId) {
        setStatus("idle");
        setStatusText(translate("Site ready", "साइट तैयार है"));
      } else {
        await pollSiteIndex(started.jobId, started.siteId || "", runId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start site indexing.";
      setSiteChat((previous) => ({ ...previous, status: "failed", message }));
      setStatus("idle");
      setStatusText(translate("Could not start site chat", "साइट चैट शुरू नहीं हो सकी"));
    }
  };

  const checkCurrentSiteSafety = async () => {
    if (!activeTabUrl || isRestrictedPage(activeTabUrl)) {
      setStatus("idle");
      setStatusText(translate("Open a normal website first", "पहले सामान्य वेबसाइट खोलें"));
      return;
    }
    if (!settings.siteChatEndpoint.trim()) {
      setStatus("idle");
      setStatusText(translate("Add the Site knowledge API endpoint in Settings", "सेटिंग्स में साइट नॉलेज API endpoint जोड़ें"));
      setSettingsOpen(true);
      return;
    }
    const runId = ++siteSafetyRunRef.current;
    setSiteSafetyLoading(true);
    setStatus("thinking");
    setStatusText(translate("Checking site safety...", "साइट सुरक्षा जांच रहे हैं..."));
    try {
      const result = await requestSiteSafety({ endpoint: settings.siteChatEndpoint, apiKey: settings.siteChatApiKey }, activeTabUrl);
      if (runId !== siteSafetyRunRef.current) return;
      setSiteSafety(result);
      setStatus("idle");
      setStatusText(translate("Safety check complete", "सुरक्षा जांच पूरी हुई"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not check site safety.";
      setStatus("idle");
      setStatusText(message);
    } finally {
      if (runId === siteSafetyRunRef.current) setSiteSafetyLoading(false);
    }
  };

  const clearSiteChat = () => {
    resetSiteChatSession();
    setStatusText(translate("Ready", "तैयार"));
  };

  const answerFromSite = async (question: string) => {
    const currentSite = siteChatRef.current;
    if (currentSite.status !== "ready" || !currentSite.siteId) return;
    const userMessage: ChatMessage = { id: `site-user-${Date.now()}`, role: "user", text: question };
    const history: SiteChatHistoryEntry[] = siteChatMessages.slice(-8).map((message) => ({
      role: message.role,
      content: message.text,
    }));
    setSiteChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText(translate("Searching site knowledge...", "साइट नॉलेज खोज रहे हैं..."));
    try {
      const response = await askSiteQuestion(siteChatConfig(), currentSite.siteId, question, history);
      const sourceText = response.sources?.length
        ? `\n\nSources: ${response.sources.slice(0, 3).map((source) => source.title || source.url).filter(Boolean).join(" • ")}`
        : "";
      const answer = `${response.answer}${sourceText}`;
      setSiteChatMessages((previous) => [...previous, { id: `site-assistant-${Date.now()}`, role: "assistant", text: answer }]);
      setStatus("idle");
      setStatusText(translate("Answer ready", "जवाब तैयार है"));
      await speakStatus(response.answer.slice(0, 500));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not answer from this site.";
      setSiteChatMessages((previous) => [...previous, { id: `site-assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText(translate("Could not answer", "जवाब नहीं मिल सका"));
    }
  };

  const answerFromSnips = async (question: string) => {
    if (snips.length === 0) return;
    const userMessage: ChatMessage = { id: `user-${Date.now()}`, role: "user", text: question };
    const conversation = chatMessages.slice(-8).map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n");
    setChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText(translate("Reading selected area...", "चयनित क्षेत्र पढ़ रहे हैं..."));
    try {
      const answer = await answerAboutSnips(
        {
          provider: settings.llmProvider,
          apiKey: settings.llmApiKey,
          endpoint: settings.llmEndpoint,
          model: settings.llmModel,
        },
        conversation ? `Conversation so far:\n${conversation}\nCurrent question: ${question}` : question,
        snips,
      );
      setChatMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", text: answer.text }]);
      setStatus("idle");
      setStatusText(translate("Answer ready", "जवाब तैयार है"));
      await speakStatus(answer.text.slice(0, 500));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not answer from the selected area.";
      setChatMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText(translate("Could not answer", "जवाब नहीं मिल सका"));
    }
  };

  const answerFromPage = async (question: string) => {
    if (!activeTabId) return;
    const userMessage: ChatMessage = { id: `page-user-${Date.now()}`, role: "user", text: question };
    setChatMessages((previous) => [...previous, userMessage]);
    setStatus("thinking");
    setStatusText(translate("Reading the current page...", "वर्तमान पेज पढ़ रहे हैं..."));
    try {
      const snapshot = await fetchPageSnapshot(activeTabId);
      const answer = await answerAboutPage(
        { provider: settings.llmProvider, apiKey: settings.llmApiKey, endpoint: settings.llmEndpoint, model: settings.llmModel },
        question,
        snapshot,
      );
      setChatMessages((previous) => [...previous, { id: `page-assistant-${Date.now()}`, role: "assistant", text: answer.text }]);
      setStatus("idle");
      setStatusText(translate("Answer ready", "जवाब तैयार है"));
      await speakStatus(answer.text.slice(0, 500));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not answer from the current page.";
      setChatMessages((previous) => [...previous, { id: `page-assistant-${Date.now()}`, role: "assistant", text: message }]);
      setStatus("idle");
      setStatusText(translate("Could not answer", "जवाब नहीं मिल सका"));
    }
  };

  const waitForTabLoad = async (tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> => {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, loadedTab?: chrome.tabs.Tab) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        if (error) reject(error); else resolve(loadedTab || tab);
      };
      const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, updatedTab: chrome.tabs.Tab) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") finish(undefined, updatedTab);
      };
      const onRemoved = (removedTabId: number) => {
        if (removedTabId === tabId) finish(new Error("The controlled tab was closed."));
      };
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the tab to load.")), timeoutMs);
      chrome.tabs.onUpdated.addListener(onUpdated);
      chrome.tabs.onRemoved.addListener(onRemoved);
    });
  };

  const showPreparationGuidance = async (task: SubTask, message: string, reason?: "restricted_page" | "tab_closed" | "load_timeout" | "action_failed") => {
    const resolvedReason = reason || (/timed out|timeout/i.test(message) ? "load_timeout" : /closed|removed/i.test(message) ? "tab_closed" : /normal webpage|Chrome blocks/i.test(message) ? "restricted_page" : "action_failed");
    const guidance = buildGuidance(resolvedReason, { translate, taskLabel: task.label, error: message });
    publishTaskCard(task.id, { status: "failed", currentStep: guidance.title, error: guidance.whatHappened, guidance });
    await speakStatus(`${guidance.title}. ${guidance.whatToDo[0] || ""}`.trim());
  };

  const decomposeWithRetry = async (request: string): Promise<SubTask[]> => {
    const config = { provider: settings.llmProvider, apiKey: settings.llmApiKey, endpoint: settings.llmEndpoint, model: settings.llmModel } as const;
    decompositionNoticeRef.current = null;
    const useSingleTaskFallback = () => {
      decompositionNoticeRef.current = translate("I couldn't split that command, so I will run it as one task.", "मैं इस कमांड को अलग नहीं कर पाया, इसलिए इसे एक काम की तरह चला रहा हूँ।");
      return fallbackToSingleTask(request);
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await decomposeRequest(config, request);
      } catch (error) {
        if (!isPlannerRateLimitError(error)) return useSingleTaskFallback();
        if (attempt >= 2) return useSingleTaskFallback();
        const retryAfterMs = Math.max(250, getPlannerRetryAfterMs(error) ?? 500 * (2 ** attempt));
        setStatusText(`${translate("Rate limited, retrying", "रेट लिमिट है, फिर कोशिश कर रहे हैं")} (${attempt + 1}/2)`);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      }
    }
    return useSingleTaskFallback();
  };

  const maybeSpeakCombinedSummary = async () => {
    if (summarySpokenGenerationRef.current === taskRunGenerationRef.current || activeTaskIdsRef.current.length === 0) return;
    const cards = activeTaskIdsRef.current.map((id) => taskViewsRef.current.get(id)).filter(Boolean) as TaskCardState[];
    if (cards.length !== activeTaskIdsRef.current.length || cards.some((card) => ["queued", "running", "waiting_confirmation", "waiting_question", "waiting_user", "paused"].includes(card.status))) return;
    summarySpokenGenerationRef.current = taskRunGenerationRef.current;
    const completed = cards.filter((card) => card.status === "done").map((card) => `${card.label}: ${card.summary || "completed"}`);
    const failed = cards.filter((card) => card.status !== "done").map((card) => `${card.label}: ${card.error || card.currentStep || "not completed"}`);
    const summary = [...completed, ...failed].join(". ");
    if (settings.focusCompletedTab) {
      const firstCompleted = cards.find((card) => card.status === "done" && card.tabId !== null);
      if (firstCompleted?.tabId !== null && firstCompleted?.tabId !== undefined) {
        await chrome.tabs.update(firstCompleted.tabId, { active: true });
      }
    }
    if (summary) await speakStatus(summary);
    setStatus("idle");
    setStatusText(translate("All tasks finished", "सभी काम पूरे हो गए"));
  };

  const runTaskForCard = async (task: SubTask, tabId: number): Promise<TaskRunnerResult> => {
    const resolvedPlanner = resolvePlanner({ provider: settings.llmProvider, apiKey: settings.llmApiKey, endpoint: settings.llmEndpoint, model: settings.llmModel });
    const planner = resolvedPlanner.planner;
    if (resolvedPlanner.degraded) {
      setStatusText(resolvedPlanner.reason || "Using offline mock planner — not an LLM.");
    }
    const context = createTaskRunnerContext({
      tabId,
      goal: task.goal,
      planner,
      sendTabMessage,
      translate,
      callbacks: {
        onStatus: (taskStatus, text) => {
          publishTaskCard(task.id, { status: taskStatus, currentStep: text, ...(taskStatus === "done" ? { summary: text } : {}) });
          if (taskStatus === "waiting_confirmation") enqueueConfirmation(task.id);
          if (taskStatus === "waiting_question") enqueueQuestion(task.id);
        },
        onStep: (entry) => {
          const current = taskViewsRef.current.get(task.id);
          publishTaskCard(task.id, { steps: [...(current?.steps || []), entry], currentStep: entry.spokenSummary || entry.action.action });
          if (task.id === activeTaskIdsRef.current[0]) {
            stepsRef.current = [...(current?.steps || []), entry];
            setSteps(stepsRef.current);
          }
        },
        onPrompt: async (text, kind) => {
          if (kind === "confirmation") await speakStatus(text);
        },
        onGuidance: async (guidance) => {
          publishTaskCard(task.id, {
            guidance,
            currentStep: guidance.title,
            error: guidance.whatHappened,
          });
          await speakStatus(`${guidance.title}. ${guidance.whatToDo[0] || ""}`.trim());
        },
        onRateLimited: (attempt) => publishTaskCard(task.id, { currentStep: `${translate("Rate limited, retrying", "रेट लिमिट है, फिर कोशिश कर रहे हैं")} (${attempt}/2)` }),
      },
    });
    taskContextsRef.current.set(task.id, context);
    if (settings.llmProvider !== "mock" && !settings.llmApiKey.trim()) {
      const guidance = buildGuidance("no_api_key", { translate, taskLabel: task.label, tabTitle: taskViewsRef.current.get(task.id)?.tabTitle });
      applyTaskGuidance(context, guidance);
      publishTaskCard(task.id, { status: "paused", currentStep: guidance.title, error: guidance.whatHappened, guidance });
      return { status: "paused", error: guidance.whatHappened, context };
    }
    if (activeTaskIdsRef.current.length === 1 && isFormFillIntent(task.goal) && !formFillRef.current) {
      try {
        const snapshot = await fetchPageSnapshot(tabId);
        const collected = collectFormFields(snapshot);
        if (collected.manualFields.length > 0) {
          await sendTabMessage(tabId, { type: "BV_HIGHLIGHT_MANUAL_FIELDS", fields: collected.manualFields });
        }
        if (collected.fields.length > 0) {
          const llmConfig = {
            provider: settings.llmProvider,
            apiKey: settings.llmApiKey,
            endpoint: settings.llmEndpoint,
            model: settings.llmModel,
          } as const;
          publishTaskCard(task.id, { status: "waiting_question", currentStep: "Understanding the form…" });
          setStatusText(translate("Understanding the form…", "फॉर्म समझ रहे हैं…"));
          const understood = await understandFormFields(llmConfig, collected.fields, {
            languageCode: resolveSpeechLanguage(settings.languageCode, task.goal),
            pageTitle: snapshot.title,
            pageSummary: snapshot.summary,
            conversation: conversationRef.current,
          });
          formFillRef.current = {
            tabId,
            goal: task.goal,
            fields: understood.fields,
            index: 0,
            completed: new Set(),
            answers: new Map(),
            skippedManualCount: collected.manualFields.length,
            plannerMode: understood.mode,
            awaitingSubmitApproval: false,
          };
          publishTaskCard(task.id, {
            status: "waiting_question",
            currentStep: understood.mode === "llm" ? "Waiting for form details (LLM)" : "Waiting for form details (heuristic)",
          });
          if (collected.manualFields.length > 0) {
            await speakStatus("I will leave sensitive and file fields for you to handle manually.");
          }
          if (understood.mode === "heuristic" && settings.llmProvider !== "mock") {
            await speakStatus("Form questions are using the local understanding engine right now. Configure or check your LLM key for richer questions.");
          }
          await askNextFormField();
          return { status: "waiting_question", context };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not inspect the form.";
        const guidance = buildGuidance("action_failed", { translate, taskLabel: task.label, error: message });
        applyTaskGuidance(context, guidance, "failed");
        publishTaskCard(task.id, { status: "failed", error: guidance.whatHappened, currentStep: guidance.title, guidance });
        return { status: "failed", error: guidance.whatHappened, context };
      }
    }
    const result = await runAgentTask(context);
    if (result.status === "waiting_confirmation") {
      publishTaskCard(task.id, { status: "waiting_confirmation", confirmationMessage: context.pendingConfirmation?.message || context.pendingQuestion || "Waiting for your response" });
    } else if (result.status === "waiting_question") {
      publishTaskCard(task.id, { status: "waiting_question", currentStep: context.pendingQuestion || "Waiting for your answer" });
      enqueueQuestion(task.id);
    } else {
      publishTaskCard(task.id, { status: result.status, summary: result.summary, error: result.error, guidance: context.guidance || undefined });
    }
    await maybeSpeakCombinedSummary();
    return result;
  };

  const runTasksWithLimit = async (tasks: Array<{ task: SubTask; tabId: number }>) => {
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < tasks.length) {
        if (isStoppedRef.current) return;
        const index = nextIndex++;
        const item = tasks[index];
        await runTaskForCard(item.task, item.tabId);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(settings.taskConcurrency, tasks.length) }, () => worker()));
  };

  // Keep the multi-tab orchestration separate from the legacy single-tab loop
  // below. This lets existing form-follow-up behavior remain available while
  // all new commands use isolated task runners.
  const runParallelTask = async (initialRequest: string, resumeExistingTask = false) => {
    if (!resumeExistingTask && snips.length > 0) {
      await answerFromSnips(initialRequest);
      return;
    }
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    if (!resumeExistingTask) {
      formFillRef.current = null;
      taskGoalRef.current = null;
      conversationRef.current = [];
      awaitingUserReplyRef.current = false;
    }
    const tasks = shouldCallDecompositionModel(initialRequest)
      ? await decomposeWithRetry(initialRequest)
      : fallbackToSingleTask(initialRequest);
    if (isStoppedRef.current) return;
    const generation = ++taskRunGenerationRef.current;
    summarySpokenGenerationRef.current = 0;
    taskViewsRef.current.clear();
    taskContextsRef.current.clear();
    confirmationQueueRef.current = [];
    questionQueueRef.current = [];
    setActiveConfirmationTaskId(null);
    setActiveQuestionTaskId(null);
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    activeTaskIdsRef.current = tasks.map((task) => task.id);
    const queuedTasks = tasks.map((task) => ({ id: task.id, label: task.label, tabId: null, tabTitle: "", status: "queued" as const, currentStep: translate("Queued", "कतार में"), steps: [] }));
    setTaskCards(queuedTasks);
    taskViewsRef.current = new Map(queuedTasks.map((task) => [task.id, task]));
    setSteps([]);
    setStatus("thinking");
    setStatusText(decompositionNoticeRef.current || (tasks.length > 1 ? translate("Opening task tabs...", "काम के टैब खोल रहे हैं...") : translate("Analyzing page...", "पेज का विश्लेषण हो रहा है...")));
    if (decompositionNoticeRef.current) await speakStatus(decompositionNoticeRef.current);

    const tabAssignments: Array<{ task: SubTask; tabId: number }> = [];
    if (tasks.length === 1) {
      const task = tasks[0];
      try {
        const tabInfo = await chrome.tabs.get(activeTabId);
        const tabId = activeTabId;
        if (task.startUrl && (isRestrictedPage(tabInfo.url) || /\b(?:open|go|navigate|visit|kholo|खोलो)\b/i.test(initialRequest))) {
          await chrome.tabs.update(tabId, { url: task.startUrl });
          await waitForTabLoad(tabId);
        } else if (isRestrictedPage(tabInfo.url)) {
          const directUrl = resolveDirectNavigationIntent(initialRequest);
          if (!directUrl) throw new Error("Please open a normal webpage before starting this task.");
          await chrome.tabs.update(tabId, { url: directUrl });
          await waitForTabLoad(tabId);
        }
        tabAssignments.push({ task, tabId });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not prepare the task tab.";
        await showPreparationGuidance(task, message, /normal webpage|Chrome blocks/i.test(message) ? "restricted_page" : undefined);
      }
    } else {
      for (const task of tasks) {
        try {
          const tab = await chrome.tabs.create({ url: task.startUrl || "https://www.google.com", active: false });
          if (!tab.id) throw new Error(`Could not create a tab for ${task.label}.`);
          await waitForTabLoad(tab.id);
          const connected = await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId: tab.id });
          if (!connected?.ok) throw new Error(`Could not connect Browse Voice to the ${task.label} tab.`);
          tabAssignments.push({ task, tabId: tab.id });
          publishTaskCard(task.id, { tabId: tab.id, tabTitle: tab.title || task.label, faviconUrl: tab.favIconUrl });
        } catch (error) {
          const message = error instanceof Error ? error.message : `Could not prepare the ${task.label} tab.`;
          await showPreparationGuidance(task, message);
        }
      }
    }

    if (generation !== taskRunGenerationRef.current) return;
    for (const assignment of [...tabAssignments]) {
      try {
        const tab = await chrome.tabs.get(assignment.tabId);
        publishTaskCard(assignment.task.id, { tabId: assignment.tabId, tabTitle: tab.title || assignment.task.label, faviconUrl: tab.favIconUrl });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The task tab was closed before it could start.";
        await showPreparationGuidance(assignment.task, message, "tab_closed");
        const index = tabAssignments.findIndex((item) => item.task.id === assignment.task.id);
        if (index >= 0) tabAssignments.splice(index, 1);
      }
    }
    await runTasksWithLimit(tabAssignments);
    await maybeSpeakCombinedSummary();
  };

  const startTaskRun = async (initialRequest: string, resumeExistingTask = false) => runParallelTask(initialRequest, resumeExistingTask);

  const runAgentLoop = async (initialRequest: string, resumeExistingTask = false) => startTaskRun(initialRequest, resumeExistingTask);

  const publishTaskResult = (taskId: string, result: TaskRunnerResult) => {
    const context = result.context;
    if (result.status === "waiting_confirmation") {
      publishTaskCard(taskId, {
        status: result.status,
        confirmationMessage: context.pendingConfirmation?.message || "Waiting for your response",
        guidance: undefined,
      });
    } else if (result.status === "waiting_question") {
      publishTaskCard(taskId, {
        status: result.status,
        currentStep: context.pendingQuestion || "Waiting for your answer",
        guidance: context.guidance || undefined,
      });
      enqueueQuestion(taskId);
    } else {
      publishTaskCard(taskId, {
        status: result.status,
        summary: result.summary,
        error: result.error,
        guidance: context.guidance || undefined,
        currentStep: context.guidance?.title || result.summary || result.error || taskViewsRef.current.get(taskId)?.currentStep || "",
      });
    }
  };

  const handleTaskGuidanceAction = async (taskId: string, guidanceAction: GuidanceAction) => {
    const task = taskViewsRef.current.get(taskId);
    const context = taskContextsRef.current.get(taskId);
    if (guidanceAction.kind === "open_settings") {
      setSettingsOpen(true);
      return;
    }
    if (guidanceAction.kind === "focus_tab") {
      if (task?.tabId !== null && task?.tabId !== undefined) await chrome.tabs.update(task.tabId, { active: true });
      return;
    }
    if (guidanceAction.kind === "open_url") {
      if (task?.tabId !== null && task?.tabId !== undefined && guidanceAction.payload) {
        await chrome.tabs.update(task.tabId, { url: guidanceAction.payload });
        publishTaskCard(taskId, { currentStep: translate("Page opened. Tap Continue when it is ready.", "पेज खुल गया। तैयार होने पर Continue दबाएँ।") });
      }
      return;
    }
    if (guidanceAction.kind === "dismiss") {
      publishTaskCard(taskId, { status: "failed", currentStep: translate("Task dismissed.", "काम बंद कर दिया गया।") });
      return;
    }
    if (!context) return;
    if (context.pendingQuestion) {
      enqueueQuestion(taskId);
      return;
    }
    const result = await resumeAgentTask(context, true, guidanceAction.kind === "retry" ? "retry" : "continue");
    publishTaskResult(taskId, result);
    await maybeSpeakCombinedSummary();
  };

  const confirmTask = async (confirmed: boolean, answer?: string) => {
    const taskId = activeConfirmationTaskId || confirmationQueueRef.current[0];
    if (!taskId) return;
    const context = taskContextsRef.current.get(taskId);
    if (!context) { advanceConfirmationQueue(); return; }
    advanceConfirmationQueue();
    setPendingConfirmationAction(null);
    setConfirmationMessage("");
    const result = await resumeAgentTask(context, confirmed, answer);
    if (result.status === "waiting_confirmation") enqueueConfirmation(taskId);
    else publishTaskResult(taskId, result);
    await maybeSpeakCombinedSummary();
  };

  const reaskConfirmation = async (taskId: string) => {
    const context = taskContextsRef.current.get(taskId);
    const message = context?.pendingConfirmation?.message;
    if (!message) return;
    setStatus("confirmation");
    setStatusText(translate("Please answer yes or no", "कृपया हाँ या नहीं कहें"));
    await speakStatus(message);
  };

  const answerTask = async (answer: string) => {
    const taskId = activeQuestionTaskId || questionQueueRef.current[0];
    if (!taskId || !answer.trim()) return;
    const context = taskContextsRef.current.get(taskId);
    if (!context) { advanceQuestionQueue(); return; }
    advanceQuestionQueue();
    const result = await resumeAgentTask(context, true, answer.trim());
    if (result.status === "waiting_question") enqueueQuestion(taskId);
    else if (result.status === "waiting_confirmation") enqueueConfirmation(taskId);
    else publishTaskResult(taskId, result);
    await maybeSpeakCombinedSummary();
  };

  const redactPrivateTranscript = (text: string) => text.replace(/\b\d{6,}\b/g, "[REDACTED]").replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]").replace(/\b(?:\d[ -]*?){12,19}\b/g, "[REDACTED]");
  const waitingUserContext = () => Array.from(taskContextsRef.current.values()).find((context) => context.guidance?.reason === "user_input_required" || context.guidance?.reason === "sensitive_field");
  const continuePhrase = (text: string) => /^(?:done|ho\s*gaya|ho\s*gya|kar\s*diya|bhar\s*diya|continue|aage\s*badho|ok\s*done|हो\s*गया|आगे\s*बढ़ो)$/i.test(text.trim());
  const handleWaitingUserReply = async (text: string) => {
    const context = waitingUserContext();
    if (!context) return false;
    if (continuePhrase(text)) {
      await resumeAgentTask(context, true, text);
    } else {
      await speakStatus(translate("Please type it yourself; do not say it aloud.", "कृपया इसे स्वयं टाइप करें, ज़ोर से न बोलें।"));
    }
    return true;
  };

  const startVoiceListening = async () => {
    if (!voiceSessionActiveRef.current || micSessionRef.current.isActive()) return;
    const generation = ++voiceListenGenerationRef.current;
    setShowMicPermissionHelp(false);
    setTranscript("");
    setStatus("listening");
    setStatusText(translate("Listening... Say stop or tap to end.", "सुन रहे हैं... रोकने के लिए stop कहें या टैप करें।"));

    try {
      if (settings.gnaniApiKey) {
        const speechLanguage = settings.languageCode;
        gnaniWsRef.current = new GnaniPrismaWebSocketClient(
          { apiKey: settings.gnaniApiKey, languageCode: speechLanguage, sttModel: "prisma-v3.0" },
          (text) => {
            if (generation === voiceListenGenerationRef.current && voiceSessionActiveRef.current) setTranscript(text);
          },
          (err) => console.warn("Prisma WS error:", err),
        );
        await gnaniWsRef.current.connect().catch((error) => console.warn("Prisma connect fallback:", error));
      }

      await micSessionRef.current.start(
        (pcmChunk) => {
          if (generation === voiceListenGenerationRef.current) gnaniWsRef.current?.sendAudioChunk(pcmChunk);
        },
        (text, isFinal) => {
          if (generation !== voiceListenGenerationRef.current || !voiceSessionActiveRef.current) return;
          setTranscript(text);
          if (isStopCommand(text)) {
            handleEmergencyStop();
            return;
          }
          if (isFinal && !voiceTurnProcessingRef.current) {
            micSessionRef.current.stop();
            gnaniWsRef.current?.disconnect();
            void voiceTurnHandlerRef.current(text);
          }
        },
        settings.languageCode,
      );
    } catch (error) {
      voiceSessionActiveRef.current = false;
      setVoiceSessionActive(false);
      micSessionRef.current.stop();
      gnaniWsRef.current?.disconnect();
      setStatus("idle");
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof DOMException ? error.name : "";
      if (errorName === "NotAllowedError" || errorMessage.includes("Permission dismissed")) {
        const guidance = buildGuidance("mic_denied", { translate });
        setGlobalGuidance(guidance);
        setStatusText(guidance.title);
        setShowMicPermissionHelp(true);
      } else {
        const guidance = buildGuidance("action_failed", { translate, error: errorMessage });
        setGlobalGuidance(guidance);
        setStatusText(guidance.title);
        alert(`Microphone error: ${errorMessage}`);
      }
      const guidance = errorName === "NotAllowedError" || errorMessage.includes("Permission dismissed")
        ? buildGuidance("mic_denied", { translate })
        : buildGuidance("action_failed", { translate, error: errorMessage });
      await speakStatus(`${guidance.title}. ${guidance.whatToDo[0] || ""}`.trim());
    }
  };

  const processVoiceTurn = async (text: string) => {
    if (voiceTurnProcessingRef.current) return;
    voiceTurnProcessingRef.current = true;
    voiceListenGenerationRef.current += 1;
    micSessionRef.current.stop();
    gnaniWsRef.current?.disconnect();
    try {
      if (isStopCommand(text)) {
        handleEmergencyStop();
        return;
      }
      if (await handleWaitingUserReply(text)) {
        setTranscript(redactPrivateTranscript(text));
      } else if (activeQuestionTaskId) {
        await answerTask(text);
      } else if (activeConfirmationTaskId) {
        if (isConfirmationCommand(text)) {
          await confirmTask(true, text);
        } else if (isCancellationCommand(text)) {
          await confirmTask(false, text);
        } else {
          await reaskConfirmation(activeConfirmationTaskId);
        }
      } else {
        await handleUserRequestSafely(text);
      }
    } catch (error) {
      setStatus("idle");
      setStatusText(error instanceof Error ? error.message : translate("I could not process that reply.", "मैं उस जवाब को प्रोसेस नहीं कर सका।"));
    } finally {
      voiceTurnProcessingRef.current = false;
      if (voiceSessionActiveRef.current && !micSessionRef.current.isActive()) {
        void startVoiceListeningRef.current();
      }
    }
  };

  voiceTurnHandlerRef.current = processVoiceTurn;
  startVoiceListeningRef.current = startVoiceListening;

  /** One tap starts voice conversation mode; another tap ends it. */
  const toggleRecording = async () => {
    if (voiceSessionActiveRef.current) {
      const partialTranscript = transcript.trim();
      voiceSessionActiveRef.current = false;
      setVoiceSessionActive(false);
      voiceListenGenerationRef.current += 1;
      micSessionRef.current.stop();
      gnaniWsRef.current?.disconnect();
      if (partialTranscript && !voiceTurnProcessingRef.current) {
        await processVoiceTurn(partialTranscript);
      } else if (!voiceTurnProcessingRef.current) {
        setStatus("idle");
        setStatusText(translate("Ready", "तैयार"));
      }
      return;
    }

    voiceSessionActiveRef.current = true;
    setVoiceSessionActive(true);
    await startVoiceListening();
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPrompt.trim()) return;
    const prompt = currentPrompt.trim();
    setCurrentPrompt("");
    setTranscript(redactPrivateTranscript(prompt));

    if (isStopCommand(prompt)) {
      handleEmergencyStop();
      return;
    }

    if (waitingUserContext()) {
      void handleWaitingUserReply(prompt);
      return;
    }

    if (isSelectionCommand(prompt)) {
      selectArea();
      return;
    }

    if (activeQuestionTaskId) {
      void answerTask(prompt);
      return;
    }

    if (activeConfirmationTaskId) {
      if (isConfirmationCommand(prompt)) void confirmTask(true, prompt);
      else if (isCancellationCommand(prompt)) void confirmTask(false, prompt);
      else void reaskConfirmation(activeConfirmationTaskId);
      return;
    }

    void handleUserRequestSafely(prompt);
  };

  const runQuickPrompt = (prompt: string) => {
    setCurrentPrompt("");
    setTranscript(prompt);
    void handleUserRequestSafely(prompt);
  };

  const updateLanguage = (languageCode: string) => {
    const nextSettings = { ...settings, languageCode };
    setSettings(nextSettings);
    chrome.storage.local.set({ browseVoiceSettings: nextSettings });
    const resolvedLanguage = resolveSpeechLanguage(languageCode, taskGoalRef.current || transcript) as InterfaceLanguage;
    setStatusText(UI_TRANSLATIONS.Ready?.[resolvedLanguage] || (resolvedLanguage === "hi-IN" ? "तैयार" : "Ready"));
  };

  const taskStatusLabel = (taskStatus: TaskRunnerStatus): string => {
    const labels: Record<TaskRunnerStatus, [string, string]> = {
      queued: ["Queued", "कतार में"],
      running: ["Running", "चल रहा है"],
      waiting_confirmation: ["Waiting for confirmation", "पुष्टि की प्रतीक्षा"],
      waiting_question: ["Question", "सवाल"],
      waiting_user: ["Waiting for you", "आपकी प्रतीक्षा"],
      paused: ["Paused", "रुका हुआ"],
      blocked: ["Blocked", "रुका हुआ"],
      done: ["Done", "पूरा हुआ"],
      failed: ["Failed", "विफल"],
      stopped: ["Stopped", "रोक दिया गया"],
    };
    return translate(...labels[taskStatus]);
  };

  return (
    <>
      {/* Header with Brand & Emergency Stop */}
      <header className="panel-header">
        <div className="brand-wrapper">
          <span className="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg></span>
          <div>
            <div className="brand-title-row"><div className="brand-title">Browse Voice</div><span className="brand-live-dot" /></div>
            <select
              className="language-select"
              value={settings.languageCode}
              onChange={(event) => updateLanguage(event.target.value)}
              aria-label="Speech language"
              title="Speech language"
            >
              {SUPPORTED_INDIAN_LANGUAGES.map((language) => (
                <option key={language.code} value={language.code}>{language.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="header-actions">
          <button
            className="btn-stop"
            onClick={handleEmergencyStop}
            title="Stop the current task"
          >
            <span className="stop-square" /> {translate("Stop", "रोकें")}
          </button>
          <button
            className="btn-icon"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Open settings"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37a1.724 1.724 0 0 0 2.572-1.065z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>

      {/* Keep consequential action confirmations visible outside the scroll area. */}
      {activeConfirmationTaskId && pendingConfirmationAction && (
        <div className="confirmation-box" role="alert">
          <div className="confirmation-header">
            <span className="alert-mark" aria-hidden="true">!</span>
            <span>{translate("Confirmation required", "पुष्टि आवश्यक है")}</span>
          </div>
          <p className="confirmation-text">
            <strong>{taskViewsRef.current.get(activeConfirmationTaskId)?.label}</strong>{" · "}
            {taskViewsRef.current.get(activeConfirmationTaskId)?.tabTitle || translate("Controlled tab", "नियंत्रित टैब")}<br />
            {confirmationMessage}
          </p>
          <div className="confirmation-actions">
            <button className="btn-confirm-yes" onClick={() => void confirmTask(true, "yes")}>
              ✓ {translate("Confirm", "पुष्टि करें")}
            </button>
            <button
              className="btn-confirm-no"
              onClick={() => void confirmTask(false, "no")}
            >
              ✕ {translate("Cancel", "रद्द करें")}
            </button>
          </div>
        </div>
      )}

      {activeQuestionTaskId && taskContextsRef.current.get(activeQuestionTaskId)?.pendingQuestion && (
        <div className="question-box" role="dialog" aria-label="Question">
          <div className="confirmation-header">
            <span className="alert-mark" aria-hidden="true">?</span>
            <span>{translate("Question", "सवाल")}</span>
          </div>
          <p className="confirmation-text">
            <strong>{taskViewsRef.current.get(activeQuestionTaskId)?.label}</strong>{" · "}
            {taskViewsRef.current.get(activeQuestionTaskId)?.tabTitle || translate("Controlled tab", "नियंत्रित टैब")}<br />
            {taskContextsRef.current.get(activeQuestionTaskId)?.pendingQuestion}
          </p>
          <form className="question-answer-row" onSubmit={(event) => { event.preventDefault(); if (questionAnswer.trim()) { void answerTask(questionAnswer); setQuestionAnswer(""); } }}>
            <input
              className="input-text"
              value={questionAnswer}
              onChange={(event) => setQuestionAnswer(event.target.value)}
              placeholder={translate("Type your answer...", "अपना जवाब लिखें...")}
              autoFocus
            />
            <button className="btn-primary" type="submit">{translate("Answer", "जवाब")}</button>
          </form>
          {(taskContextsRef.current.get(activeQuestionTaskId)?.pendingQuestionOptions || []).length > 0 && (
            <div className="question-options" aria-label="Question options">
              {taskContextsRef.current.get(activeQuestionTaskId)?.pendingQuestionOptions.map((option) => (
                <button key={option} type="button" className="question-option" onClick={() => void answerTask(option)}>{option}</button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main Body */}
      <div className="panel-body">
        {/* Status Card */}
        <div className="status-card">
          <div className="status-indicator">
            <span className={`status-dot ${status}`} />
            <span className="status-label">{statusText}</span>
          </div>
          <div className="status-engine" title={activeTabTitle || "Current browser tab"}>
            <span className="engine-dot" />
            <span>{describePlannerMode({ provider: settings.llmProvider, apiKey: settings.llmApiKey, model: settings.llmModel }).label}</span>
          </div>
        </div>

        {globalGuidance && (
          <div className="task-guidance global-guidance" role="status">
            <strong>{globalGuidance.title}</strong>
            <p>{globalGuidance.whatHappened}</p>
            <ul>{globalGuidance.whatToDo.slice(0, 3).map((instruction) => <li key={instruction}>{instruction}</li>)}</ul>
            <div className="task-guidance-actions">
              {globalGuidance.actions.map((guidanceAction) => (
                <button
                  key={`${guidanceAction.kind}-${guidanceAction.label}`}
                  type="button"
                  className="task-guidance-button"
                  onClick={() => {
                    if (guidanceAction.kind === "open_settings") setSettingsOpen(true);
                    if (guidanceAction.kind === "dismiss") setGlobalGuidance(null);
                    if (guidanceAction.kind === "retry") { setGlobalGuidance(null); void startVoiceListening(); }
                  }}
                >{guidanceAction.label}</button>
              ))}
            </div>
          </div>
        )}

        {taskCards.length > 0 && (
          <section className="task-list-section" aria-label="Parallel tasks">
            <div className="steps-heading">
              <div><div className="section-title">{translate("PARALLEL TASKS", "समानांतर काम")}</div><div className="steps-title">{translate("Task tabs", "काम के टैब")}</div></div>
              <span className="steps-count">{taskCards.length}</span>
            </div>
            <div className="task-card-list">
              {taskCards.map((task) => (
                <article className={`task-card ${task.status}`} key={task.id}>
                  <div className="task-card-header">
                    <div className="task-card-identity">
                      {task.faviconUrl ? <img src={task.faviconUrl} alt="" className="task-favicon" /> : <span className="task-favicon-placeholder" aria-hidden="true">↗</span>}
                      <div><strong>{task.label}</strong><span>{task.tabTitle || translate("Preparing tab...", "टैब तैयार हो रहा है...")}</span></div>
                    </div>
                    <button
                      type="button"
                      className="task-stop-button"
                      disabled={["done", "failed", "stopped"].includes(task.status)}
                      onClick={() => {
                        const context = taskContextsRef.current.get(task.id);
                        if (context) stopAgentTask(context);
                        publishTaskCard(task.id, { status: "stopped", currentStep: translate("Stopped", "रोक दिया गया") });
                      }}
                    >{translate("Stop", "रोकें")}</button>
                  </div>
                  <div className="task-status-row"><span className={`task-status-dot ${task.status}`} /><span>{taskStatusLabel(task.status)}</span></div>
                  <div className="task-current-step">{task.currentStep}</div>
                  {task.guidance && (
                    <div className="task-guidance" role="status">
                      <strong>{task.guidance.title}</strong>
                      <p>{task.guidance.whatHappened}</p>
                      <ul>
                        {task.guidance.whatToDo.slice(0, 3).map((instruction) => <li key={instruction}>{instruction}</li>)}
                      </ul>
                      <div className="task-guidance-actions">
                        {task.guidance.actions.map((guidanceAction) => (
                          <button key={`${guidanceAction.kind}-${guidanceAction.label}`} type="button" className="task-guidance-button" onClick={() => void handleTaskGuidanceAction(task.id, guidanceAction)}>
                            {guidanceAction.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {/* Restricted Page Warning Banner */}
        {activeTabUrl && isRestrictedPage(activeTabUrl) && (
          <div className="restricted-banner" role="status">
            <span className="restricted-icon" aria-hidden="true">!</span>
            <div><strong>{translate("Restricted page", "प्रतिबंधित पेज")}</strong><span className="restricted-copy">{translate("Chrome blocks extensions here. You can still say", "Chrome यहां extensions को block करता है। आप कह सकते हैं")} <em>“open YouTube”</em> {translate("or", "या")} <em>“open LeetCode”</em> {translate("to navigate away.", "दूसरे पेज पर जाने के लिए।")}</span></div>
          </div>
        )}

        {/* Microphone Voice Control Card */}
        <section className="mic-section" aria-label="Voice controls">
          <div className="voice-toolbar">
            <div className="voice-kicker">{translate("VOICE CONTROL", "वॉइस कंट्रोल")}</div>
            <div className="voice-toolbar-actions">
              <button className="select-area-button" type="button" onClick={selectArea}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 8h8v8H8z"/></svg>
                {translate("Select area", "क्षेत्र चुनें")}
              </button>
              <button
                className="site-safety-button"
                type="button"
                onClick={() => void checkCurrentSiteSafety()}
                disabled={siteSafetyLoading}
                title="Check this site for security and phishing risk signals"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.4 2.9 8.4 7 10 4.1-1.6 7-5.6 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/></svg>
                {siteSafetyLoading ? translate("Checking…", "जांच हो रही है…") : translate("Check site", "साइट जांचें")}
              </button>
              <button
                className="site-chat-button"
                type="button"
                onClick={() => void startSiteChat()}
                disabled={siteChat.status === "queued" || siteChat.status === "crawling" || siteChat.status === "processing"}
                title="Crawl this website and chat with its indexed knowledge"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2 2.2 3 4.9 3 8s-1 5.8-3 8c-2-2.2-3-4.9-3-8s1-5.8 3-8Z"/></svg>
                {siteChat.status === "queued" || siteChat.status === "crawling" || siteChat.status === "processing" ? translate("Indexing…", "इंडेक्स हो रहा है…") : translate("Chat with site", "साइट से चैट करें")}
              </button>
            </div>
          </div>
          <button
            className={`mic-button ${voiceSessionActive ? "recording" : ""}`}
            onClick={toggleRecording}
            title={voiceSessionActive ? "Tap to end voice conversation" : "Tap to start a voice conversation"}
            aria-label={status === "listening" ? "Stop listening" : "Start voice input"}
          >
            {status === "listening" ? <span className="recording-mark" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3m-4 0h8"/></svg>}
          </button>
          <div className="mic-prompt-title">{voiceSessionActive ? translate("Listening…", "सुन रहे हैं…") : translate("Tap mic to speak", "बोलने के लिए माइक दबाएं")}</div>
          <div className="mic-help">
            {voiceSessionActive
              ? status === "listening"
                ? "Listening... I will listen again after each reply. Say 'stop' or tap to end."
                : "Voice conversation active. I will listen again when I finish this turn. Tap to end."
              : translate("Speak naturally or try a quick prompt", "स्वाभाविक रूप से बोलें या कोई quick prompt चुनें")}
          </div>
          {!voiceSessionActive && (
            <div className="quick-prompts" aria-label="Quick prompts">
              <button type="button" onClick={() => runQuickPrompt("Check electricity bill")}>{translate("Check electricity bill", "बिजली का बिल देखें")}</button>
              <button type="button" onClick={() => runQuickPrompt("Pay utility bill")}>{translate("Pay utility bill", "बिजली का बिल भरें")}</button>
              <button type="button" onClick={() => runQuickPrompt("Download payment receipt")}>{translate("Download payment receipt", "भुगतान रसीद डाउनलोड करें")}</button>
            </div>
          )}
          {showMicPermissionHelp && (
            <div className="mic-permission-help">
              <span>{translate("Chrome needs microphone approval in a regular tab.", "Chrome को सामान्य टैब में माइक की अनुमति चाहिए।")}</span>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  chrome.tabs.create({
                    url: chrome.runtime.getURL("sidepanel/mic-permission.html"),
                  });
                }}
              >
                {translate("Grant microphone access", "माइक की अनुमति दें")}
              </button>
              <span>{translate("Allow access there, close that tab, then tap the microphone again.", "वहां अनुमति दें, टैब बंद करें और फिर माइक दबाएं।")}</span>
            </div>
          )}

          {/* Live Transcript View */}
          <div className="transcript-card">
            <div className="transcript-header">{translate("Live Transcript", "लाइव ट्रांसक्रिप्ट")}</div>
            <div className="transcript-text">
              {transcript || <span className="transcript-empty">{translate("Your voice will appear here...", "आपकी आवाज़ यहां दिखाई देगी...")}</span>}
            </div>
          </div>

          {snips.length > 0 && (
            <div className="snip-context" aria-label="Selected page areas">
              <div className="snip-context-header">
                <span>{translate("Selected context", "चयनित संदर्भ")}</span>
                <span>{snips.length}/4</span>
              </div>
              <div className="snip-chip-list">
                {snips.map((snip, index) => (
                  <div className="snip-chip" key={snip.id}>
                    <img src={snip.imageDataUrl} alt={`Selected area ${index + 1}`} />
                    <span>{translate("Area", "क्षेत्र")} {index + 1}</span>
                    <button
                      type="button"
                      aria-label={`Remove selected area ${index + 1}`}
                      onClick={() => setSnips((previous) => previous.filter((item) => item.id !== snip.id))}
                    >×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {siteChat.status !== "idle" && (
            <div className={`site-chat-card ${siteChat.status}`} aria-label="Site chat status">
              <div className="site-chat-card-header">
                <div>
                  <div className="site-chat-kicker">{translate("SITE KNOWLEDGE", "साइट नॉलेज")}</div>
                  <strong>{siteChat.startUrl ? new URL(siteChat.startUrl).hostname : "Current website"}</strong>
                </div>
                <button type="button" className="site-chat-clear" onClick={clearSiteChat}>{translate("Clear", "साफ़ करें")}</button>
              </div>
              <div className="site-chat-progress">
                <span className="site-chat-dot" />
                <span>
                  {siteChat.status === "ready"
                    ? translate("Indexed and ready for questions", "इंडेक्स तैयार है, आप सवाल पूछ सकते हैं")
                    : siteChat.status === "failed"
                      ? siteChat.message || translate("Indexing failed", "इंडेक्सिंग विफल रही")
                      : `${siteChat.message || translate("Crawler is working", "क्रॉलर काम कर रहा है")}${siteChat.pagesIndexed > 0 ? ` · ${siteChat.pagesIndexed}${siteChat.totalPages ? `/${siteChat.totalPages}` : ""} ${translate("pages", "पेज")}` : ""}`}
                </span>
              </div>
            </div>
          )}

          {siteSafety && (
            <div className={`site-safety-card ${siteSafety.verdict}`} aria-label="Site safety result">
              <div className="site-safety-card-header">
                <div>
                  <div className="site-chat-kicker">{translate("SITE SAFETY", "साइट सुरक्षा")}</div>
                  <strong>
                    {siteSafety.verdict === "low-risk"
                      ? translate("Low risk", "कम जोखिम")
                      : siteSafety.verdict === "caution"
                        ? translate("Use caution", "सावधानी बरतें")
                        : siteSafety.verdict === "high-risk"
                          ? translate("High risk", "उच्च जोखिम")
                          : translate("Unknown", "अज्ञात")}
                  </strong>
                </div>
                <span className="site-safety-score">{siteSafety.score}/100</span>
              </div>
              <p className="site-safety-summary">{siteSafety.summary}</p>
              {siteSafety.reasons.length > 0 && (
                <div className="site-safety-reasons">
                  {siteSafety.reasons.slice(0, 5).map((reason, index) => (
                    <div className="site-safety-reason" key={`${reason.title}-${index}`}>
                      <span className={`safety-severity ${reason.severity}`} aria-hidden="true" />
                      <div><strong>{reason.title}</strong><span>{reason.detail}</span></div>
                    </div>
                  ))}
                </div>
              )}
              <div className="site-safety-disclaimer">
                {translate("This is a risk assessment, not proof that a site is fake or legitimate.", "यह जोखिम आकलन है; इससे साइट के नकली या वैध होने का पक्का प्रमाण नहीं मिलता।")}
              </div>
            </div>
          )}

          {chatMessages.length > 0 && (
            <div className="chat-thread" aria-label="Snip conversation">
              {chatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === "user" ? translate("You", "आप") : "Browse Voice"}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          )}

          {siteChatMessages.length > 0 && (
            <div className="chat-thread site-chat-thread" aria-label="Site conversation">
              {siteChatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span className="chat-role">{message.role === "user" ? translate("You", "आप") : translate("Site knowledge", "साइट नॉलेज")}</span>
                  <p>{message.text}</p>
                </div>
              ))}
            </div>
          )}

          {/* Manual Text Fallback */}
          <form className="send-row" onSubmit={handleManualSubmit}>
            <input
              type="text"
              className="input-text"
              placeholder={translate("Or type a command here...", "या यहां कमांड लिखें...")}
              value={currentPrompt}
              onChange={(e) => setCurrentPrompt(e.target.value)}
            />
            <button type="submit" className="btn-primary">
              {translate("Send", "भेजें")}
            </button>
          </form>
        </section>

        {/* Step Execution Timeline */}
        <div className="step-log-section">
          <div className="steps-heading"><div><div className="section-title">{translate("ACTIVITY", "गतिविधि")}</div><div className="steps-title">{translate("Execution steps", "एक्जीक्यूशन स्टेप्स")}</div></div><span className="steps-count">{steps.length} / 15</span></div>
          {steps.length === 0 ? (
            <div className="empty-steps">
              <span className="empty-steps-icon" aria-hidden="true">ϟ</span>
              <div><strong>{translate("Your actions will appear here", "आपकी कार्रवाइयां यहां दिखाई देंगी")}</strong><span>{translate("Automated web clicks, fills, and navigation will stream live", "वेब क्लिक, फिल और नेविगेशन यहां दिखाई देंगे")}</span></div>
            </div>
          ) : (
            <div className="step-list">
              {steps.map((step) => (
                <div key={step.stepNumber} className={`step-card ${step.status}`}>
                  <div className="step-card-header">
                    <span className="step-badge">{translate("Step", "चरण")} {step.stepNumber}</span>
                    <span className="step-action-tag">{ACTION_TAG_TRANSLATIONS[resolveSpeechLanguage(settings.languageCode, taskGoalRef.current || transcript)]?.[step.action.action] || step.action.action.toUpperCase()}</span>
                  </div>
                  {step.action.rationale && (
                    <div className="step-rationale">{step.action.rationale}</div>
                  )}
                  {step.spokenSummary && (
                    <div className="step-speech">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10v4h4l5 4V6l-5 4H4Zm12-1a5 5 0 0 1 0 6m2-9a9 9 0 0 1 0 12"/></svg>
                      <span>{step.spokenSummary}</span>
                    </div>
                  )}
                  {step.details && (
                    <div style={{ fontSize: "11px", color: "var(--accent-red)" }}>
                      {step.details}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <footer className="panel-footer">
        <span><span className="footer-live-dot" /> {translate("Secure Web Sandbox Active", "सिक्योर वेब सैंडबॉक्स सक्रिय है")}</span>
        <span className="feedback-link">{translate("Feedback", "फीडबैक")}</span>
      </footer>

      {/* Settings Modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{translate("Settings", "सेटिंग्स")}</span>
              <button
                className="btn-icon"
                onClick={() => setSettingsOpen(false)}
                style={{ border: "none" }}
              >
                ✕
              </button>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Language", "भाषा")}</label>
              <select
                className="form-select"
                value={settings.languageCode}
                onChange={(e) => updateLanguage(e.target.value)}
              >
                {SUPPORTED_INDIAN_LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label} ({lang.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Gnani AI API Key</label>
              <input
                type="password"
                className="form-input"
                placeholder={translate("Enter Gnani API Key", "Gnani API Key दर्ज करें")}
                value={settings.gnaniApiKey}
                onChange={(e) => setSettings({ ...settings, gnaniApiKey: e.target.value })}
              />
              <span className="form-help">
                {translate("Required for Gnani Prisma STT and Timbre TTS. Stored securely in chrome.storage.local.", "Gnani Prisma STT और Timbre TTS के लिए आवश्यक है। chrome.storage.local में सुरक्षित रूप से सेव है।")}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Planner Provider", "प्लानर प्रोवाइडर")}</label>
              <select
                className="form-select"
                value={settings.llmProvider}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    llmProvider: e.target.value as "mock" | "openai-compatible" | "huggingface" | "gemini",
                    ...(e.target.value === "huggingface"
                      ? { llmEndpoint: HUGGINGFACE_ENDPOINT, llmModel: DEFAULT_HUGGINGFACE_MODEL }
                      : {}),
                  })
                }
              >
                <option value="mock">{translate("Rule-Based Mock Planner (Offline Demo)", "रूल-बेस्ड मॉक प्लानर (ऑफलाइन डेमो)")}</option>
                <option value="gemini">Google Gemini (AI Studio)</option>
                <option value="huggingface">Hugging Face Inference Providers</option>
                <option value="openai-compatible">OpenAI-Compatible LLM</option>
              </select>
            </div>

            {/* Gemini fields: only API key needed (endpoint is automatic) */}
            {settings.llmProvider === "gemini" && (
              <>
                <div className="form-group">
                  <label className="form-label">Gemini API Key (Google AI Studio)</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="AIza..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                  <span className="form-help">
                    Get your free key at{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      aistudio.google.com/apikey
                    </a>
                  </span>
                </div>

                <div className="form-group">
                  <label className="form-label">Gemini Model</label>
                  <select
                    className="form-select"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  >
                    <option value="gemini-3.8-flash">gemini-3.8-flash (Recommended)</option>
                  </select>
                </div>
              </>
            )}

            {settings.llmProvider === "openai-compatible" && (
              <>
                <div className="form-group">
                  <label className="form-label">LLM API Key</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="sk-..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">LLM Base Endpoint</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="https://api.openai.com/v1"
                    value={settings.llmEndpoint}
                    onChange={(e) => setSettings({ ...settings, llmEndpoint: e.target.value })}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">LLM Model Name</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="gpt-4o-mini or deepseek-chat"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  />
                </div>
              </>
            )}

            {settings.llmProvider === "huggingface" && (
              <>
                <div className="form-group">
                  <label className="form-label">Hugging Face token</label>
                  <input
                    type="password"
                    className="form-input"
                    placeholder="hf_..."
                    value={settings.llmApiKey}
                    onChange={(e) => setSettings({ ...settings, llmApiKey: e.target.value })}
                  />
                  <span className="form-help">
                    Create a token with Inference Providers access at{" "}
                    <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                      Hugging Face settings
                    </a>
                    . It is saved in chrome.storage.local.
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label">Hugging Face model</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="organization/model:provider"
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                  />
                  <span className="form-help">
                    Default uses openai/gpt-oss-20b on DeepInfra. Inference usage may require HF credits.
                  </span>
                </div>
              </>
            )}

            <div className="settings-divider" />
            <div className="form-group">
              <label className="form-label">{translate("Site knowledge API endpoint", "साइट नॉलेज API endpoint")}</label>
              <input
                type="url"
                className="form-input"
                placeholder="https://your-api.example.com"
                value={settings.siteChatEndpoint}
                onChange={(e) => setSettings({ ...settings, siteChatEndpoint: e.target.value })}
              />
              <span className="form-help">
                {translate("The service crawls the current site, creates embeddings, stores them in your vector store, and answers site questions.", "यह सर्विस वर्तमान साइट को crawl करके embeddings बनाती है, vector store में सेव करती है और सवालों के जवाब देती है।")}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Site knowledge API key (optional)", "साइट नॉलेज API key (वैकल्पिक)")}</label>
              <input
                type="password"
                className="form-input"
                placeholder="Service API key"
                value={settings.siteChatApiKey}
                onChange={(e) => setSettings({ ...settings, siteChatApiKey: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Maximum pages per site", "प्रति साइट अधिकतम पेज")}</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={250}
                value={settings.siteChatMaxPages}
                onChange={(e) => setSettings({ ...settings, siteChatMaxPages: Math.min(250, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>

            <div className="form-group">
              <label className="form-label">{translate("Parallel task limit", "समानांतर काम की सीमा")}</label>
              <input
                type="number"
                className="form-input"
                min={1}
                max={4}
                value={settings.taskConcurrency}
                onChange={(e) => setSettings({ ...settings, taskConcurrency: Math.min(4, Math.max(1, Number(e.target.value) || 1)) })}
              />
            </div>

            <label className="settings-check-row">
              <input
                type="checkbox"
                checked={settings.focusCompletedTab}
                onChange={(e) => setSettings({ ...settings, focusCompletedTab: e.target.checked })}
              />
              <span>{translate("Focus the first completed task tab", "पहले पूरे हुए काम के टैब पर जाएं")}</span>
            </label>

            <button
              className="btn-primary"
              style={{ marginTop: "8px" }}
              onClick={() => saveSettings(settings)}
            >
              {translate("Save Settings", "सेटिंग्स सेव करें")}
            </button>
          </div>
        </div>
      )}
    </>
  );
};
