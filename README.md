# Browse Voice (Phase 1) 🎙️⚡

> A voice-controlled agentic browser assistant for Indian-language users powered by **Gnani AI** and **Chrome Manifest V3**.

Browse Voice enables users to navigate, fill forms, and complete multi-step tasks across web portals entirely using spoken Indian languages (Hindi, Hinglish, English, and major Indic languages).

---

## 🏗️ Architecture

```text
BrowseVoice/
├── manifest.json              # Manifest V3 Extension Configuration
├── package.json               # NPM scripts, dependencies (React 19, TypeScript, Vite)
├── tsconfig.json              # TypeScript configuration
├── vite.config.ts             # Vite build pipeline bundling into dist/
├── sidepanel/                 # Chrome Side Panel UI & Voice Orchestration
│   ├── index.html             # Side panel host page
│   ├── main.tsx               # React 19 entry
│   ├── App.tsx                # Master agent loop, state machine & safety controls
│   ├── mic.ts                 # Persistent microphone capture & PCM streaming
│   └── styles.css             # Responsive dark-theme side panel styling
├── content/                   # Content scripts injected into live pages
│   ├── observer.ts            # Page snapshot extractor (DOM & accessibility tree)
│   ├── executor.ts            # Action runner (click, type, select, scroll, navigate)
│   ├── overlay.css            # Floating "Agent is Active" indicator & highlights
│   └── index.ts               # Content script message coordinator
├── background/                # Manifest V3 Background Service Worker
│   └── service-worker.ts      # Tab management, side panel behavior & header rules
├── lib/                       # Core Shared Libraries
│   ├── gnani.ts               # Gnani Prisma STT (WebSocket) & Timbre TTS client
│   ├── planner.ts             # Swappable Planner Provider interface & implementations
│   ├── schema.ts              # Strict JSON Schema validation for 7 planner actions
│   └── safety.ts              # Mandatory safety checks, PII protection & stop rules
├── mock-portal/               # BijliSeva Mock Electricity Bill Payment Portal
│   ├── index.html             # Multi-step portal with dummy data & sensitive fields
│   ├── styles.css             # Utility portal styling
│   ├── portal.js              # Interactive client-side portal logic
│   └── server.mjs             # Standalone zero-dependency HTTP server (port 3000)
└── tests/                     # Test Suite
    └── commands.test.mjs      # 10 sample Hindi/Hinglish/English commands & safety tests
```

---

## ⚡ Quick Start & Installation

### 1. Build the Extension

From the `BrowseVoice` folder, install dependencies and build:

```bash
cd BrowseVoice
npm install
npm run build
```

This compiles TypeScript and bundles assets into the `dist/` directory.

### 2. Load the Extension into Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `BrowseVoice/dist` folder.
5. Click on the **Browse Voice** extension icon in your Chrome toolbar or open the Chrome Side Panel and choose **Browse Voice**.

---

## 🌐 Running the BijliSeva Mock Portal

To test the agent loop on a realistic Indian utility bill-payment workflow:

```bash
npm run portal
```

Open [http://localhost:3000](http://localhost:3000) in your browser. The mock portal features:
* **Quick Electricity Bill Lookup**: Enter Consumer Number (e.g. `100234567`) and click *Check Bill*.
* **Bill Details**: Displays outstanding electricity bill statement for `₹1,450.00`.
* **Payment Form**: Contains sensitive card number and CVV fields, and a payment submit button.
* **Confirmation Receipt**: Generates a mock transaction receipt upon payment.
* **Consumer Login**: Includes password and OTP input fields to verify sensitive field safety blocks.

---

## 🎙️ Gnani AI Integration Details

Endpoints and configurations follow the official documentation at [https://docs.gnani.ai](https://docs.gnani.ai):

### 1. Speech-to-Text: Gnani Prisma
* **Streaming WebSocket Endpoint:** `wss://api.vachana.ai/stt/v3/stream`
* **Audio Input:** Raw 16-bit Linear PCM, single-channel (mono), 16,000 Hz.
* **Handshake Upgrade Headers:**
  * `x-api-key-id`: Your Gnani API Key
  * `language_code`: `"hi-IN"` (Hindi), `"indic-auto"` (Auto-detect Indic), `"en-IN"` (Indian English), etc.
  * `model`: `"prisma-v3.0"` (or `"prisma-v2.5"`)
* **REST Fallback:** `POST https://api.vachana.ai/stt/v3` (multipart/form-data with WAV audio).

> **Browser Header Note:** Per `docs.gnani.ai`, standard browser JavaScript `new WebSocket()` does not support custom connection headers. In this extension, we inject the required headers via `chrome.declarativeNetRequest` rules. A built-in browser Web Speech fallback is also available if no key is entered.

### 2. Text-to-Speech: Gnani Timbre
* **Inference Endpoint:** `POST https://api.vachana.ai/api/v1/tts/inference`
* **Headers:**
  * `Content-Type: application/json`
  * `X-API-Key-ID: <gnani_api_key>`
* **Payload:**
  ```json
  {
    "text": "कंज्यूमर नंबर 100234567 दर्ज किया जा रहा है।",
    "voice": "Nalini",
    "model": "timbre-v2.5",
    "language": "hi-IN",
    "speed": 1,
    "audio_config": {
      "encoding": "linear_pcm",
      "container": "wav",
      "num_channels": 1,
      "sample_rate": 48000,
      "sample_width": 2
    }
  }
  ```
* **Playback:** Binary WAV audio streamed and played through HTML5 Web Audio (`HTMLAudioElement`).

---

## 🧠 Planner LLM Interface (`lib/planner.ts`)

The planner is abstracted behind the `PlannerProvider` interface:

```typescript
export interface PlannerProvider {
  readonly id: string;
  readonly name: string;
  plan(request: PlannerRequest): Promise<PlannerAction>;
}
```

### Supported Providers:
1. **Mock / Rule-Based Planner (`mock`)**: Included out of the box for instant zero-dependency testing on the mock portal.
2. **OpenAI-Compatible LLM (`openai-compatible`)**: Connects to OpenAI, OpenRouter, DeepSeek, Groq, or local Ollama instances.

### Strict JSON Action Schema (`lib/schema.ts`):
The planner returns strictly ONE validated action per turn:
* `click(id)`: `{"action": "click", "id": 3, "rationale": "..."}`
* `type(id, text)`: `{"action": "type", "id": 1, "text": "100234567", "rationale": "..."}`
* `select(id, value)`: `{"action": "select", "id": 2, "value": "delhi-north", "rationale": "..."}`
* `scroll(direction)`: `{"action": "scroll", "direction": "down", "amount": 300}`
* `navigate(url)`: `{"action": "navigate", "url": "https://..."}`
* `ask_user(question)`: `{"action": "ask_user", "question": "..."}`
* `done(summary)`: `{"action": "done", "summary": "..."}`

---

## 🛡️ Mandatory Safety Rules Enforced

1. **Sensitive Field Protection (Passwords, OTPs, Card & Aadhaar Numbers)**
   * Detects sensitive fields by input type (`type="password"`), autocomplete attributes (`one-time-code`, `cc-number`), and regex identifier patterns (`password`, `otp`, `pin`, `cvv`, `card_number`, `aadhaar`, `uidai`).
   * Never reads, logs, or speaks sensitive values; masks them as `[REDACTED_SENSITIVE]`.
   * **Action Block:** If an action attempts to type into a sensitive field, the executor immediately blocks it and speaks:
     > *"यह पासवर्ड, ओटीपी या कार्ड फील्ड है। सुरक्षा के लिए कृपया इसे खुद भरें।"* (Please fill this manually).

2. **Spoken Confirmation Gating (Submit & Payment Actions)**
   * Before executing any irreversible action (buttons with `type="submit"` or labels matching `pay`, `submit`, `bharo`, `confirm`), the agent pauses execution.
   * Speaks a confirmation prompt: *"क्या आप भुगतान की पुष्टि करना चाहते हैं? कृपया 'हाँ' कहें।"*
   * Waits for explicit affirmative speech (`"yes"`, `"haan"`, `"confirm"`) or an on-screen click.

3. **Emergency Stop ("ruko" / "stop")**
   * Spoken commands matching `/\b(ruko|ruk|stop|cancel|bas|thehro)\b/i` or clicking the red **"⏹ Ruko / Stop"** button immediately terminates STT recording, halts pending LLM calls, stops TTS playback, cancels action execution, and resets the agent state.

4. **Active Session Indicator**
   * The agent only operates on the tab with which the user has an active session.
   * Injects an on-page visual badge (`🔴 Browse Voice Active`) in the top-right corner. It is automatically removed when the session stops.

5. **No Hardcoded Keys**
   * All API keys (Gnani AI key, LLM key) are stored strictly inside `chrome.storage.local` entered by the user via the in-app Settings dialog (`⚙️`).

---

## 🧪 Running Automated Tests

Run the sample command suite:

```bash
npm test
```

### 10 Verified Sample Commands:

| # | Command | Language / Style | Expected Action & Safety Behavior |
|---|---|---|---|
| 1 | `"bijli bill dekho"` | Hinglish | Types consumer number `100234567` into lookup field |
| 2 | `"mera consumer number 100234567 daalo"` | Hinglish | Extracts number and types into consumer field |
| 3 | `"bill check karo"` | Hindi | Clicks "Check Bill / बिल देखें" button |
| 4 | `"bill bharo"` | Hindi | Clicks "Proceed to Pay / बिल भरें" button |
| 5 | `"pay electricity bill"` | English | Advances from bill summary to payment gateway |
| 6 | `"show my pending bills"` | English | Evaluates page summary and reports `₹1,450` due (`done`) |
| 7 | `"proceed to payment"` | English | Clicks proceed to pay button |
| 8 | `"ruko"` | Hindi Stop Word | Verified by safety engine to trigger immediate stop |
| 9 | `"stop"` | English Stop Word | Verified by safety engine to trigger immediate stop |
| 10 | `"ha payment confirm karo"` | Hindi / Hinglish | Satisfies payment confirmation gating and clicks Submit |

*Plus:* Dedicated safety test verifying that attempting to type into a sensitive field (`password`, `card_number`, `cvv`, `aadhaar_no`) is blocked.

---

## ⚙️ Configuration & Settings

Click the **⚙️ Settings** icon in the side panel header to configure:
* **Language (`language_code`)**: Hindi (`hi-IN`), Indic Auto-detect (`indic-auto`), English (`en-IN`), Tamil, Telugu, Kannada, Marathi, Gujarati, Bengali, Punjabi, Malayalam.
* **Gnani AI API Key**: Your API key from the Gnani developer console.
* **Planner Provider**: Choose between **Rule-Based Mock Planner** (for offline demo) or **OpenAI-Compatible LLM** (enter API key, endpoint, and model name).

---

## ⚠️ Known Limitations (Phase 1)

* **Browser Native WebSocket Headers**: Native browser WebSockets do not permit passing custom HTTP headers. In this extension, headers are attached via `chrome.declarativeNetRequest`. For standalone web clients, Gnani recommends an intermediate proxy.
* **Multi-Page Sub-Frames (iFrames)**: Phase 1 interacts with the top-level document. Cross-origin nested iframes are isolated by the browser security sandbox.
* **Captcha and Bot Challenges**: Captchas require manual user intervention.
* **Audio Permissions**: Chrome side panels must be opened and active for persistent microphone capture.
