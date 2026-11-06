/**
 * Gnani AI Client for Browse Voice
 *
 * Official Documentation Reference: https://docs.gnani.ai
 *
 * 1. SPEECH-TO-TEXT (Prisma v3.0 / v2.5 Realtime WebSocket & REST):
 *    - Realtime Streaming WebSocket Endpoint: wss://api.vachana.ai/stt/v3/stream
 *    - Audio Input: Raw 16-bit Linear PCM, single-channel (mono), 16,000 Hz
 *    - Authentication & Config Headers:
 *        x-api-key-id: <gnani_api_key>
 *        language_code: "hi-IN" | "indic-auto" | "en-IN" | ...
 *        model: "prisma-v3.0" (or "prisma-v2.5")
 *    - REST Endpoint (fallback): POST https://api.vachana.ai/stt/v3
 *
 * 2. TEXT-TO-SPEECH (Timbre v3.0 / v2.5 Synchronous Inference):
 *    - Inference Endpoint: POST https://api.vachana.ai/api/v1/tts/inference
 *    - Headers:
 *        Content-Type: application/json
 *        X-API-Key-ID: <gnani_api_key>
 *    - Voices: "Nalini", "Avinash", "Shivani", "Lakshmi", "Kalpana", etc.
 *    - Audio Container: "wav", Linear PCM 48kHz / 16kHz
 */

export interface GnaniConfig {
  apiKey: string;
  languageCode: string; // e.g. 'hi-IN', 'indic-auto', 'en-IN'
  sttModel?: "prisma-v3.0" | "prisma-v2.5";
  ttsModel?: "timbre-v3.0" | "timbre-v2.5";
  ttsVoice?: string; // e.g. 'Nalini'
}

export const GNANI_ENDPOINTS = {
  STT_WS: "wss://api.vachana.ai/stt/v3/stream",
  STT_REST: "https://api.vachana.ai/stt/v3",
  TTS_REST: "https://api.vachana.ai/api/v1/tts/inference",
} as const;

export const SUPPORTED_INDIAN_LANGUAGES = [
  { code: "hi-IN", label: "Hindi" },
  { code: "indic-auto", label: "Auto-detect Indic" },
  { code: "en-IN", label: "Indian English" },
  { code: "ta-IN", label: "Tamil" },
  { code: "te-IN", label: "Telugu" },
  { code: "kn-IN", label: "Kannada" },
  { code: "mr-IN", label: "Marathi" },
  { code: "gu-IN", label: "Gujarati" },
  { code: "bn-IN", label: "Bengali" },
  { code: "pa-IN", label: "Punjabi" },
  { code: "ml-IN", label: "Malayalam" },
] as const;

// Global audio playback tracking to allow immediate stop on "ruko"
let currentAudioElement: HTMLAudioElement | null = null;

/**
 * Configure Chrome declarativeNetRequest rules so that outgoing WebSocket connections
 * to wss://api.vachana.ai/stt/v3/stream include the mandatory Gnani upgrade headers.
 *
 * NOTE: Per https://docs.gnani.ai, browser JavaScript cannot pass custom headers in `new WebSocket(url)`.
 * In a Manifest V3 extension, declarativeNetRequest modifies headers for WEBSOCKET resource types.
 */
export async function setupGnaniDeclarativeHeaders(apiKey: string, languageCode: string): Promise<void> {
  if (!chrome.declarativeNetRequest || !apiKey) return;

  const ruleId = 9991;
  const rule: chrome.declarativeNetRequest.Rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        {
          header: "x-api-key-id",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: apiKey,
        },
        {
          header: "language_code",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: languageCode || "hi-IN",
        },
        {
          header: "model",
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: "prisma-v3.0",
        },
      ],
    },
    condition: {
      urlFilter: "wss://api.vachana.ai/*",
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.WEBSOCKET],
    },
  };

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [ruleId],
      addRules: [rule],
    });
  } catch (err) {
    console.warn("Could not register declarativeNetRequest rule for Gnani WebSocket headers:", err);
  }
}

/**
 * Live Speech-to-Text streaming session using Gnani Prisma WebSocket API.
 */
export class GnaniPrismaWebSocketClient {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private onTranscriptCallback: (text: string, isFinal: boolean) => void;
  private onErrorCallback: (error: Error) => void;
  private config: GnaniConfig;

  constructor(
    config: GnaniConfig,
    onTranscript: (text: string, isFinal: boolean) => void,
    onError: (error: Error) => void
  ) {
    this.config = config;
    this.onTranscriptCallback = onTranscript;
    this.onErrorCallback = onError;
  }

  /**
   * Connect to Gnani Prisma WebSocket
   * Endpoint: wss://api.vachana.ai/stt/v3/stream
   */
  public async connect(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("Gnani API Key is required for Prisma STT.");
    }

    // Ensure declarative request headers are active for the WebSocket handshake
    await setupGnaniDeclarativeHeaders(this.config.apiKey, this.config.languageCode);

    return new Promise((resolve, reject) => {
      try {
        // TODO: According to docs.gnani.ai, native browser clients connecting without
        // declarativeNetRequest support (e.g. regular web apps) should route through a
        // lightweight proxy to attach the `x-api-key-id` header securely.
        this.ws = new WebSocket(GNANI_ENDPOINTS.STT_WS);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = () => {
          this.isConnected = true;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            if (typeof event.data === "string") {
              const msg = JSON.parse(event.data);
              // Server emits "connected", "processing", and "transcript" events
              if (msg.type === "transcript" && typeof msg.transcript === "string") {
                const text = msg.transcript.trim();
                if (text) {
                  this.onTranscriptCallback(text, true);
                }
              } else if (msg.transcript && typeof msg.transcript === "string") {
                this.onTranscriptCallback(msg.transcript.trim(), true);
              }
            }
          } catch (parseErr) {
            console.error("Gnani STT message parse error:", parseErr);
          }
        };

        this.ws.onerror = () => {
          const err = new Error("Gnani Prisma WebSocket error occurred.");
          this.onErrorCallback(err);
          reject(err);
        };

        this.ws.onclose = () => {
          this.isConnected = false;
        };
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a chunk of raw 16-bit Linear PCM audio to Gnani Prisma.
   */
  public sendAudioChunk(pcmData: Int16Array | ArrayBuffer): void {
    if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (pcmData instanceof Int16Array) {
        // Convert to a standalone ArrayBuffer so DOM typings and browsers that
        // reject SharedArrayBuffer-backed views receive only the audio bytes.
        const bytes = new Uint8Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
        this.ws.send(bytes.slice().buffer);
      } else {
        this.ws.send(pcmData);
      }
    }
  }

  /**
   * Stop the WebSocket session cleanly
   */
  public disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close error
      }
      this.ws = null;
      this.isConnected = false;
    }
  }
}

/**
 * Text-to-Speech synthesizer using Gnani Timbre REST API.
 * Endpoint: POST https://api.vachana.ai/api/v1/tts/inference
 *
 * Official docs specify linear_pcm in a wav container with 48kHz or 16kHz audio.
 */
export async function speakWithTimbre(
  text: string,
  config: GnaniConfig
): Promise<void> {
  // Cancel any ongoing speech immediately before starting
  stopAllSpeech();

  if (!text || text.trim().length === 0) return;

  // If no Gnani API Key is configured, fall back gracefully to browser SpeechSynthesis
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    speakWithBrowserTTS(text, config.languageCode);
    return;
  }

  try {
    const payload = {
      text: text.trim(),
      voice: config.ttsVoice || "Nalini",
      model: config.ttsModel || "timbre-v2.5",
      language: config.languageCode || "hi-IN",
      speed: 1,
      audio_config: {
        encoding: "linear_pcm",
        container: "wav",
        num_channels: 1,
        sample_rate: 48000,
        sample_width: 2,
      },
    };

    const response = await fetch(GNANI_ENDPOINTS.TTS_REST, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key-ID": config.apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`Gnani Timbre TTS failed (${response.status}): ${errText}. Falling back to browser TTS.`);
      speakWithBrowserTTS(text, config.languageCode);
      return;
    }

    const audioBlob = await response.blob();
    const audioUrl = URL.createObjectURL(audioBlob);

    const audio = new Audio(audioUrl);
    currentAudioElement = audio;

    return new Promise((resolve) => {
      audio.onended = () => {
        URL.revokeObjectURL(audioUrl);
        currentAudioElement = null;
        resolve();
      };
      audio.onerror = () => {
        URL.revokeObjectURL(audioUrl);
        currentAudioElement = null;
        // Fallback on playback failure
        speakWithBrowserTTS(text, config.languageCode);
        resolve();
      };
      audio.play().catch(() => {
        speakWithBrowserTTS(text, config.languageCode);
        resolve();
      });
    });
  } catch (err) {
    console.warn("Gnani Timbre request error. Falling back to browser speech synthesis:", err);
    speakWithBrowserTTS(text, config.languageCode);
  }
}

/**
 * Fallback browser TTS using window.speechSynthesis for testing/offline support.
 */
export function speakWithBrowserTTS(text: string, languageCode: string = "hi-IN"): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = languageCode === "indic-auto" ? "hi-IN" : languageCode;
  utterance.rate = 1.0;
  window.speechSynthesis.speak(utterance);
}

/**
 * Immediately stops any ongoing Timbre audio or browser speech synthesis.
 * Essential for the "ruko" / "stop" safety rule!
 */
export function stopAllSpeech(): void {
  if (currentAudioElement) {
    try {
      currentAudioElement.pause();
      currentAudioElement.currentTime = 0;
    } catch {
      // Ignore
    }
    currentAudioElement = null;
  }

  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore
    }
  }
}

/**
 * Helper to convert Float32Array from Web Audio API microphone stream to 16-bit PCM.
 */
export function float32ToInt16PCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}
