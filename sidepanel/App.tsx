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
  createPlanner,
  answerAboutSnips,
  type PlannerProvider,
  type StepLogEntry,
  type LLMConfig,
  type SnipContext,
} from "../lib/planner";
import {
  inspectActionSafety,
  isStopCommand,
  isConfirmationCommand,
  type PageSnapshot,
} from "../lib/safety";
import { validatePlannerAction, type PlannerAction } from "../lib/schema";
import { MicrophoneSession } from "./mic";
import {
  askSiteQuestion,
  getSiteIndexProgress,
  startSiteIndexing,
  type SiteChatHistoryEntry,
  type SiteIndexProgress,
  type SiteIndexStatus,
} from "../lib/site-chat";

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
  /** "gemini" = Google AI Studio, "openai-compatible" = any OpenAI-spec API, "mock" = offline demo */
  llmProvider: "mock" | "openai-compatible" | "gemini";
  llmApiKey: string;
  llmEndpoint: string;
  llmModel: string;
  siteChatEndpoint: string;
  siteChatApiKey: string;
  siteChatMaxPages: number;
}

interface FormFieldDescriptor {
  fingerprint: string;
  identity: string;
  occurrence: number;
  label: string;
  tag: string;
  type?: string;
  kind: "text" | "select" | "checkbox" | "radio";
  name?: string;
  options?: string[];
}

interface FormFillSession {
  tabId: number;
  goal: string;
  fields: FormFieldDescriptor[];
  index: number;
  completed: Set<string>;
  skippedManualCount: number;
}

function collectFormFields(snapshot: PageSnapshot): { fields: FormFieldDescriptor[]; manualCount: number } {
  const occurrenceByIdentity = new Map<string, number>();
  let manualCount = 0;
  const fields: FormFieldDescriptor[] = [];
  const radioGroups = new Map<string, { field: FormFieldDescriptor; labels: string[] }>();
  for (const element of snapshot.interactiveElements) {
    if (!["input", "textarea", "select"].includes(element.tag)) continue;
    const type = (element.type || "text").toLowerCase();
    if (element.tag === "input" && ["button", "submit", "reset", "hidden", "image"].includes(type)) continue;
    if (element.tag === "input" && type === "file") { manualCount += 1; continue; }
    if (element.isSensitive) {
      manualCount += 1;
      continue;
    }

    const label = element.label.trim() || element.placeholder?.trim() || element.name?.trim() || `${element.tag} field`;
    if (element.tag === "input" && type === "radio") {
      const groupName = element.name || label;
      const identity = JSON.stringify(["radio", groupName]);
      const existingGroup = radioGroups.get(identity);
      if (existingGroup) {
        if (!existingGroup.labels.includes(label)) existingGroup.labels.push(label);
      } else {
        const occurrence = occurrenceByIdentity.get(identity) || 0;
        occurrenceByIdentity.set(identity, occurrence + 1);
        const field: FormFieldDescriptor = {
          fingerprint: `${identity}#${occurrence}`, identity, occurrence,
          label: groupName.replace(/[_-]+/g, " "), tag: element.tag, type,
          kind: "radio", name: element.name, options: [label],
        };
        radioGroups.set(identity, { field, labels: field.options! });
        fields.push(field);
      }
      continue;
    }

    const identity = JSON.stringify([element.tag, element.type || "", label, element.name || "", element.placeholder || ""]);
    const occurrence = occurrenceByIdentity.get(identity) || 0;
    occurrenceByIdentity.set(identity, occurrence + 1);
    const kind = element.tag === "select" ? "select" : type === "checkbox" ? "checkbox" : "text";
    fields.push({ fingerprint: `${identity}#${occurrence}`, identity, occurrence, label, tag: element.tag, type: element.type, kind, name: element.name, options: kind === "select" ? element.options || [] : undefined });
  }
  return { fields, manualCount };
}

function findFormField(snapshot: PageSnapshot, descriptor: FormFieldDescriptor, answer?: string) {
  if (descriptor.kind === "radio") {
    const answerText = (answer || "").trim().toLowerCase();
    const optionIndex = /^\d+$/.test(answerText) ? Number(answerText) - 1 : -1;
    const selectedLabel = optionIndex >= 0
      ? descriptor.options?.[optionIndex]
      : descriptor.options?.find((option) => option.toLowerCase() === answerText || option.toLowerCase().includes(answerText));
    if (!selectedLabel) return undefined;
    return snapshot.interactiveElements.find((element) =>
      element.tag === "input" && element.type?.toLowerCase() === "radio" && element.name === descriptor.name
      && element.label.trim().toLowerCase() === selectedLabel.toLowerCase() && !element.isSensitive,
    );
  }
  const matches = snapshot.interactiveElements.filter((element) => {
    const label = element.label.trim() || element.placeholder?.trim() || element.name?.trim() || `${element.tag} field`;
    const identity = JSON.stringify([element.tag, element.type || "", label, element.name || "", element.placeholder || ""]);
    return identity === descriptor.identity && !element.isSensitive;
  });
  return matches[descriptor.occurrence];
}

function parseYesNo(value: string): boolean | null {
  const answer = value.trim();
  if (/^(yes|y|yeah|haan|ha|check|tick|true)(?:\b|$)/i.test(answer) || /^(हाँ|हां)(?:\s|$|[,!.])/u.test(answer)) return true;
  if (/^(no|n|nope|nahin|nahi|leave unchecked|false)(?:\b|$)/i.test(answer) || /^(नहीं|नहि)(?:\s|$|[,!.])/u.test(answer)) return false;
  return null;
}

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const RETIRED_GEMINI_MODELS = new Set([
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
]);

const DEFAULT_SETTINGS: SettingsState = {
  gnaniApiKey: (import.meta.env.VITE_GNANI_API_KEY as string) || "",
  languageCode: (import.meta.env.VITE_LANGUAGE_CODE as string) || "en-IN",
  llmProvider:
    (import.meta.env.VITE_LLM_PROVIDER as "mock" | "openai-compatible" | "gemini") ||
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
  llmEndpoint: (import.meta.env.VITE_LLM_ENDPOINT as string) || "https://api.openai.com/v1",
  llmModel: (import.meta.env.VITE_LLM_MODEL as string) || DEFAULT_GEMINI_MODEL,
  siteChatEndpoint: (import.meta.env.VITE_SITE_CHAT_ENDPOINT as string) || "",
  siteChatApiKey: (import.meta.env.VITE_SITE_CHAT_API_KEY as string) || "",
  siteChatMaxPages: Number(import.meta.env.VITE_SITE_CHAT_MAX_PAGES || 25),
};

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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
});

function isSelectionCommand(text: string): boolean {
  const value = text.toLowerCase().trim();
  return /(?:select|snip|capture|screenshot|crop|highlight).*(?:area|this|that|section|part|region)?|(?:yeh|yah|is|this)\s+(?:select|snip|capture|screenshot)|area\s+(?:select|snip)|select\s+karo/.test(value);
}

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
  const [snips, setSnips] = useState<SnipContext[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [siteChatMessages, setSiteChatMessages] = useState<ChatMessage[]>([]);
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
    const language = settings.languageCode as InterfaceLanguage;
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
  const voiceListenGenerationRef = useRef(0);
  const voiceTurnHandlerRef = useRef<(text: string) => Promise<void>>(async () => {});
  const startVoiceListeningRef = useRef<() => Promise<void>>(async () => {});
  const siteIndexPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const siteChatRef = useRef<SiteChatState>(siteChat);
  const siteChatRunRef = useRef(0);
  const siteChatTabRef = useRef<number | null>(null);
  stepsRef.current = steps;
  siteChatRef.current = siteChat;

  const resetSiteChatSession = () => {
    if (siteIndexPollRef.current) clearTimeout(siteIndexPollRef.current);
    siteIndexPollRef.current = null;
    siteChatRunRef.current += 1;
    siteChatTabRef.current = null;
    setSiteChat({ status: "idle", startUrl: "", siteId: "", jobId: "", pagesIndexed: 0, message: "" });
    setSiteChatMessages([]);
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
    const onTabActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      if (siteChatRef.current.status !== "idle" && siteChatTabRef.current !== null && siteChatTabRef.current !== activeInfo.tabId) {
        resetSiteChatSession();
      }
      setActiveTabId(activeInfo.tabId);
      chrome.tabs.get(activeInfo.tabId, (t) => {
        if (t?.title) setActiveTabTitle(t.title);
        if (t?.url !== undefined) setActiveTabUrl(t.url || "");
      });
    };

    // Also update URL when tab updates (e.g. navigation within same tab)
    const onTabUpdated = (tabId: number, _info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.active) {
        if (siteChatRef.current.status !== "idle" && siteChatTabRef.current === tabId && tab.url && tab.url !== siteChatRef.current.startUrl) {
          resetSiteChatSession();
        }
        setActiveTabId(tabId);
        setActiveTabTitle(tab.title || "Web Page");
        setActiveTabUrl(tab.url || "");
      }
    };

    chrome.tabs.onActivated.addListener(onTabActivated);
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onTabActivated);
      chrome.tabs.onUpdated.removeListener(onTabUpdated);
    };
  }, []);

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
    setPendingConfirmationAction(null);
    taskGoalRef.current = null;
    conversationRef.current = [];
    awaitingUserReplyRef.current = false;
    formFillRef.current = null;

    // Notify tab content script to remove indicator
    if (activeTabId) {
      chrome.tabs.sendMessage(activeTabId, { type: "BV_DEACTIVATE_AGENT" }).catch(() => {});
    }
  }, [activeTabId]);

  /**
   * Query snapshot from content script
   */
  const fetchPageSnapshot = async (tabId: number): Promise<PageSnapshot> => {
    const response = await chrome.tabs.sendMessage(tabId, { type: "BV_GET_SNAPSHOT" });
    if (!response || !response.ok || !response.snapshot) {
      throw new Error(response?.error || "Failed to retrieve page snapshot from tab.");
    }
    return response.snapshot as PageSnapshot;
  };

  /**
   * Helper to speak using Gnani Timbre with Hindi / Indic language support
   */
  const speakStatus = async (text: string) => {
    if (isStoppedRef.current || !text) return;
    setStatus("speaking");
    setStatusText(text);

    const gnaniConfig: GnaniConfig = {
      apiKey: settings.gnaniApiKey,
      languageCode: settings.languageCode,
      ttsVoice: "Nalini",
      ttsModel: "timbre-v2.5",
    };

    await speakWithTimbre(text, gnaniConfig);
    if (!isStoppedRef.current) {
      setStatus("idle");
    }
  };

  const askNextFormField = async () => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return;
    const question = field.kind === "select"
      ? `Which option should I choose for ${field.label}? ${field.options?.join(", ") || ""}`
      : field.kind === "checkbox"
        ? `Should I check ${field.label}? Please answer yes or no.`
        : field.kind === "radio"
          ? `Which option should I choose for ${field.label}? ${field.options?.join(", ") || ""}`
          : `What should I enter for ${field.label}?`;
    setStatus("idle");
    setStatusText(`${translate("Field", "फील्ड")} ${session.index + 1} ${translate("of", "में से")} ${session.fields.length}: ${field.label}`);
    await speakStatus(question);
    setStatusText(`${translate("Reply with a value for", "इसके लिए मान बताएं:")} ${field.label}`);
  };

  const submitFormFieldAnswer = async (answer: string) => {
    const session = formFillRef.current;
    const field = session?.fields[session.index];
    if (!session || !field) return false;
    const value = answer.trim();
    if (!value) {
      setStatusText(`${translate("Please answer for", "कृपया इसका जवाब दें:")} ${field.label}`);
      return true;
    }

    setStatus("thinking");
    setStatusText(`${translate("Filling", "भर रहे हैं:")} ${field.label}...`);
    try {
      const freshSnapshot = await fetchPageSnapshot(session.tabId);
      const checkboxChoice = field.kind === "checkbox" ? parseYesNo(value) : null;
      if (field.kind === "checkbox" && checkboxChoice === null) {
        setStatus("idle");
        setStatusText(`${translate("Please answer yes or no for", "कृपया हाँ या नहीं बताएं:")} ${field.label}.`);
        return true;
      }

      const element = findFormField(freshSnapshot, field, field.kind === "radio" ? value : undefined);
      if (!element && field.kind === "radio") {
        setStatus("idle");
          setStatusText(`${translate("Choose one of these options for", "इनमें से विकल्प चुनें:")} ${field.label}: ${field.options?.join(", ") || ""}`);
        return true;
      }
      if (!element) throw new Error(`I can no longer find the ${field.label} field. Check the page and try again.`);
      let selectedValue = value;
      if (field.kind === "select") {
        const match = field.options?.find((option) => option.toLowerCase() === value.toLowerCase() || option.toLowerCase().includes(value.toLowerCase()));
        if (field.options?.length && !match) {
          setStatus("idle");
          setStatusText(`${translate("Choose one of these options for", "इनमें से विकल्प चुनें:")} ${field.label}: ${field.options.join(", ")}`);
          return true;
        }
        selectedValue = match || value;
      }
      let candidate: PlannerAction | null;
      if (field.kind === "checkbox") {
        candidate = element.checked === checkboxChoice ? null : { action: "click", id: element.id, rationale: `${checkboxChoice ? "Checked" : "Unchecked"} ${field.label}.` };
      } else if (field.kind === "radio") {
        candidate = element.checked ? null : { action: "click", id: element.id, rationale: `Selected ${value} for ${field.label}.` };
      } else if (field.kind === "select") {
        candidate = { action: "select", id: element.id, value: selectedValue };
      } else {
        candidate = { action: "type", id: element.id, text: value };
      }

      let response: { ok: boolean; error?: string; freshSnapshot?: PageSnapshot } | null = null;
      if (candidate) {
        const validation = validatePlannerAction(candidate);
        if (!validation.valid) throw new Error(validation.error);
        const safety = inspectActionSafety(validation.action, freshSnapshot);
        if (!safety.permitted) throw new Error(safety.reason || "Safety blocked this field.");
        if (safety.requiresConfirmation) {
          session.skippedManualCount += 1;
          await speakStatus(`I left ${field.label} unchanged because it needs a separate confirmation. I will continue to the next field.`);
        } else {
          response = await chrome.tabs.sendMessage(session.tabId, {
            type: "BV_EXECUTE_ACTION",
            action: validation.action,
          });
          if (!response?.ok) throw new Error(response?.error || `Could not fill ${field.label}.`);

          const stepNumber = stepsRef.current.length + 1;
          setSteps((previous) => [...previous, {
            stepNumber,
            action: validation.action,
            status: "success",
            spokenSummary: `Filled ${field.label}.`,
            timestamp: Date.now(),
          }]);
        }
      }
      session.completed.add(field.fingerprint);

      const updatedSnapshot = (response?.freshSnapshot || await fetchPageSnapshot(session.tabId)) as PageSnapshot;
      const refreshed = collectFormFields(updatedSnapshot);
      session.skippedManualCount = Math.max(session.skippedManualCount, refreshed.manualCount);
      session.fields = refreshed.fields.filter((candidateField) => !session.completed.has(candidateField.fingerprint));
      session.index = 0;

      if (session.fields.length === 0) {
        const skippedMessage = session.skippedManualCount > 0
          ? "The supported fields are filled. Fill any sensitive, file, or protected fields yourself, then review the form. I did not submit it."
          : "The visible fields are filled. Please review the form. I did not submit it.";
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
    if (siteChatRef.current.status === "ready" && siteChatRef.current.siteId) {
      await answerFromSite(text);
      return;
    }
    await runAgentLoop(text);
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

    // Fallback: treat as domain
    return `https://${siteName.replace(/\s+/g, "")}.com`;
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
      try {
        selectionResponse = await chrome.tabs.sendMessage(activeTabId, { type: "BV_START_SNIP_SELECTION" });
      } catch {
        await chrome.runtime.sendMessage({ type: "BV_ENSURE_TAB_CONNECTED", tabId: activeTabId });
        selectionResponse = await chrome.tabs.sendMessage(activeTabId, { type: "BV_START_SNIP_SELECTION" });
      }

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

  /**
   * Core Agent Execution Loop
   */
  const runAgentLoop = async (initialRequest: string) => {
    if (snips.length > 0) {
      await answerFromSnips(initialRequest);
      return;
    }
    if (!activeTabId) {
      alert("No active browser tab found.");
      return;
    }

    isStoppedRef.current = false;
    setSteps([]);
    setStatus("thinking");
    setStatusText(translate("Analyzing page...", "पेज का विश्लेषण हो रहा है..."));

    // A reply to ask_user continues the original task. New commands start a clean context.
    const isFollowUp = awaitingUserReplyRef.current && taskGoalRef.current !== null;
    if (!isFollowUp) {
      taskGoalRef.current = initialRequest;
      conversationRef.current = [{ role: "user" as const, content: initialRequest }];
    } else {
      conversationRef.current = [...conversationRef.current, { role: "user" as const, content: initialRequest }].slice(-6);
    }
    const taskGoal = taskGoalRef.current || initialRequest;
    awaitingUserReplyRef.current = false;

    // --- Check if we're on a restricted page (chrome://, new tab, etc.) ---
    const tabInfo = await chrome.tabs.get(activeTabId);
    if (isRestrictedPage(tabInfo.url)) {
      // Try to resolve navigation intent directly (no LLM needed)
      const directUrl = resolveDirectNavigationIntent(initialRequest);
      if (directUrl) {
        setStatus("executing");
        setStatusText(`${translate("Opening", "खोल रहे हैं")} ${directUrl}...`);
        const navAction: PlannerAction = {
          action: "navigate",
          url: directUrl,
          rationale: `Opening ${directUrl}.`,
        };
        setSteps([{
          stepNumber: 1,
          action: navAction,
          status: "success",
          spokenSummary: navAction.rationale,
          timestamp: Date.now(),
        }]);
        await chrome.tabs.update(activeTabId, { url: directUrl });
        setStatus("idle");
        setStatusText(translate("Navigated", "पेज खुल गया है"));
        return;
      }
      // Can't do anything else on restricted pages
      setStatus("idle");
      setStatusText(translate("⚠️ Please go to a normal webpage first", "⚠️ पहले सामान्य वेबपेज खोलें"));
      alert(
        "Browse Voice cannot control Chrome's built-in pages (new tab, chrome://settings, etc.).\n\n" +
        "Please navigate to any website (e.g. google.com) and then give your command."
      );
      return;
    }

    // 1. Activate on-page visual indicator
    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: "BV_ACTIVATE_AGENT",
        statusText: "Processing",
      });
    } catch {
      // Content script may need injection
      await chrome.runtime.sendMessage({
        type: "BV_ENSURE_TAB_CONNECTED",
        tabId: activeTabId,
      });
    }

    const planner: PlannerProvider = createPlanner({
      provider: settings.llmProvider,
      apiKey: settings.llmApiKey,
      endpoint: settings.llmEndpoint,
      model: settings.llmModel,
    });

    let currentSnapshot = await fetchPageSnapshot(activeTabId);
    const formFillIntent = /\b(fill|complete|populate|enter details|register|sign up|apply for|bhar(?:o|na|do|de))\b|फॉर्म|फ़ॉर्म|भर(?:ो|ना|ें)/i.test(taskGoal);
    if (!formFillRef.current && formFillIntent) {
      const { fields, manualCount } = collectFormFields(currentSnapshot);
      if (fields.length > 0) {
        formFillRef.current = {
          tabId: activeTabId,
          goal: taskGoal,
          fields,
          index: 0,
          completed: new Set(),
          skippedManualCount: manualCount,
        };
        if (manualCount > 0) {
          await speakStatus("I will leave sensitive and file fields for you to handle manually. I will ask about every other visible field one at a time.");
        }
        await askNextFormField();
        return;
      }
    }

    let stepCount = 0;
    const MAX_STEPS = 15;

    while (stepCount < MAX_STEPS) {
      if (isStoppedRef.current) break;
      stepCount++;

      setStatus("thinking");
        setStatusText(`${translate("Step", "स्टेप")} ${stepCount}: ${translate("Planning next action...", "अगली कार्रवाई की योजना बन रही है...")}`);

      // 2. Query Planner
      let action: PlannerAction;
      try {
        action = await planner.plan({
          userRequest: taskGoal,
          snapshot: currentSnapshot,
          history: stepsRef.current.slice(-5),
          conversation: conversationRef.current,
        });
      } catch (planErr) {
        const errMsg = planErr instanceof Error ? planErr.message : "Planning error.";
        await speakStatus(`योजना बनाने में त्रुटि: ${errMsg}`);
        if (isFollowUp) awaitingUserReplyRef.current = true;
        break;
      }

      if (isStoppedRef.current) break;

      // 3. Inspect Action Safety
      const safety = inspectActionSafety(action, currentSnapshot);

      // SENSITIVE FIELD BLOCKED
      if (!safety.permitted) {
        const speech = safety.safetyAlertSpeech || "This field contains sensitive information. Please fill it manually.";
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "blocked",
          spokenSummary: speech,
          details: safety.reason,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        await speakStatus(speech);
        break;
      }

      // SUBMIT / PAYMENT CONFIRMATION GATING
      if (safety.requiresConfirmation) {
        setStatus("confirmation");
        const confirmSpeech = safety.safetyAlertSpeech || "Do you want to confirm this action? Say yes to continue.";
        setStatusText(translate("Waiting for confirmation", "पुष्टि की प्रतीक्षा है"));
        setPendingConfirmationAction(action);
        setConfirmationMessage(confirmSpeech);

        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "confirmation_required",
          spokenSummary: confirmSpeech,
          details: safety.reason,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);

        await speakStatus(confirmSpeech);
        // Wait for user to say "haan" / "yes" or click confirm button
        return; // Pause loop until confirmation event
      }

      // Check for DONE action
      if (action.action === "done") {
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: action.summary,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: action.summary }].slice(-6);
        await speakStatus(action.summary);
        setStatus("idle");
        setStatusText(translate("Completed", "पूरा हुआ"));
        taskGoalRef.current = null;
        conversationRef.current = [];
        awaitingUserReplyRef.current = false;
        break;
      }

      // Check for ASK_USER action
      if (action.action === "ask_user") {
        const entry: StepLogEntry = {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: action.question,
          timestamp: Date.now(),
        };
        setSteps((prev) => [...prev, entry]);
        conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: action.question }].slice(-6);
        awaitingUserReplyRef.current = true;
        await speakStatus(action.question);
        setStatus("idle");
        setStatusText(translate("Awaiting response", "जवाब की प्रतीक्षा है"));
        break;
      }

      // 4. Execute Action in Tab
      setStatus("executing");
      setStatusText(`${translate("Step", "स्टेप")} ${stepCount}: ${translate("Executing", "कार्रवाई हो रही है")} ${action.action}...`);

      const execResponse = await chrome.tabs.sendMessage(activeTabId, {
        type: "BV_EXECUTE_ACTION",
        action,
      });

      if (!execResponse?.ok) {
        const err = execResponse?.error || "Action execution failed.";
        setSteps((prev) => [
          ...prev,
          {
            stepNumber: stepCount,
            action,
            status: "failed",
            details: err,
            timestamp: Date.now(),
          },
        ]);
        await speakStatus(`Action failed: ${err}`);
        break;
      }

      // Record successful step
      const rationaleText = action.rationale || `Executed ${action.action}`;
      conversationRef.current = [...conversationRef.current, { role: "assistant" as const, content: rationaleText }].slice(-6);
      setSteps((prev) => [
        ...prev,
        {
          stepNumber: stepCount,
          action,
          status: "success",
          spokenSummary: rationaleText,
          timestamp: Date.now(),
        },
      ]);

      // 5. Timbre speaks short sentence about what it is doing
      await speakStatus(rationaleText);

      // Re-observe
      if (execResponse.freshSnapshot) {
        currentSnapshot = execResponse.freshSnapshot;
      } else {
        currentSnapshot = await fetchPageSnapshot(activeTabId);
      }
    }

    if (stepCount >= MAX_STEPS) {
      await speakStatus("The maximum of 15 steps has been reached. The task was stopped.");
    }
  };

  /**
   * Resumes the loop after the user gives confirmation for submit/payment
   */
  const confirmAndResumeAction = async () => {
    if (!pendingConfirmationAction || !activeTabId) return;
    const actionToRun = pendingConfirmationAction;
    setPendingConfirmationAction(null);
    setConfirmationMessage("");

    setStatus("executing");
      setStatusText(translate("Executing confirmed action...", "पुष्टि की गई कार्रवाई हो रही है..."));

    const execResponse = await chrome.tabs.sendMessage(activeTabId, {
      type: "BV_EXECUTE_ACTION",
      action: actionToRun,
    });

    if (execResponse?.ok) {
      setSteps((prev) => [
        ...prev,
        {
          stepNumber: prev.length + 1,
          action: actionToRun,
          status: "success",
          spokenSummary: "Confirmation received. The payment was submitted.",
          timestamp: Date.now(),
        },
      ]);
      await speakStatus("The payment was submitted. The receipt is available on screen.");
      setStatus("idle");
      setStatusText(translate("Completed", "पूरा हुआ"));
    }
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
        gnaniWsRef.current = new GnaniPrismaWebSocketClient(
          { apiKey: settings.gnaniApiKey, languageCode: settings.languageCode, sttModel: "prisma-v3.0" },
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
        setStatusText(translate("Approve microphone access in the new tab", "नए टैब में माइक की अनुमति दें"));
        setShowMicPermissionHelp(true);
      } else {
        setStatusText(translate("Microphone access error", "माइक की अनुमति में त्रुटि"));
        alert(`Microphone error: ${errorMessage}`);
      }
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
      if (pendingConfirmationAction) {
        if (isConfirmationCommand(text)) await confirmAndResumeAction();
        else {
          setPendingConfirmationAction(null);
          setStatus("idle");
          await speakStatus("I cancelled that action.");
        }
      } else {
        await handleUserRequest(text);
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
    setTranscript(prompt);

    if (isStopCommand(prompt)) {
      handleEmergencyStop();
      return;
    }

    if (isSelectionCommand(prompt)) {
      selectArea();
      return;
    }

    if (pendingConfirmationAction && isConfirmationCommand(prompt)) {
      confirmAndResumeAction();
      return;
    }

    void handleUserRequest(prompt);
  };

  const runQuickPrompt = (prompt: string) => {
    setCurrentPrompt("");
    setTranscript(prompt);
    void handleUserRequest(prompt);
  };

  const updateLanguage = (languageCode: string) => {
    const nextSettings = { ...settings, languageCode };
    setSettings(nextSettings);
    chrome.storage.local.set({ browseVoiceSettings: nextSettings });
    setStatusText(languageCode === "hi-IN" ? "तैयार" : "Ready");
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
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4L7.5 15a8 8 0 0 1 0-1.9L6.1 12l1.4-2.4 1.7.7a8 8 0 0 1 1.6-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.1 1.9Z"/></svg>
          </button>
        </div>
      </header>

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
            <span>{settings.llmProvider === "mock" ? "Offline engine" : `${settings.llmModel || "AI"} engine`}</span>
          </div>
        </div>

        {/* Restricted Page Warning Banner */}
        {activeTabUrl && isRestrictedPage(activeTabUrl) && (
          <div className="restricted-banner" role="status">
            <span className="restricted-icon" aria-hidden="true">!</span>
            <div><strong>{translate("Restricted page", "प्रतिबंधित पेज")}</strong><span className="restricted-copy">{translate("Chrome blocks extensions here. You can still say", "Chrome यहां extensions को block करता है। आप कह सकते हैं")} <em>“open YouTube”</em> {translate("or", "या")} <em>“open LeetCode”</em> {translate("to navigate away.", "दूसरे पेज पर जाने के लिए।")}</span></div>
          </div>
        )}

        {/* Safety Confirmation Alert Box */}
        {pendingConfirmationAction && (
          <div className="confirmation-box">
            <div className="confirmation-header">
              <span className="alert-mark" aria-hidden="true">!</span>
              <span>{translate("Confirmation required", "पुष्टि आवश्यक है")}</span>
            </div>
            <p className="confirmation-text">{confirmationMessage}</p>
            <div className="confirmation-actions">
              <button className="btn-confirm-yes" onClick={() => void processVoiceTurn("yes")}>
                ✓ {translate("Confirm", "पुष्टि करें")}
              </button>
              <button
                className="btn-confirm-no"
                onClick={() => void processVoiceTurn("no")}
              >
                ✕ {translate("Cancel", "रद्द करें")}
              </button>
            </div>
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
                    <span className="step-badge">Step {step.stepNumber}</span>
                    <span className="step-action-tag">{step.action.action.toUpperCase()}</span>
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
                    llmProvider: e.target.value as "mock" | "openai-compatible" | "gemini",
                  })
                }
              >
                <option value="mock">{translate("Rule-Based Mock Planner (Offline Demo)", "रूल-बेस्ड मॉक प्लानर (ऑफलाइन डेमो)")}</option>
                <option value="gemini">Google Gemini (AI Studio)</option>
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
