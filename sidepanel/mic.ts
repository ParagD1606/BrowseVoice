/**
 * Microphone Capture and Audio Processing for Browse Voice.
 *
 * Requirements:
 * - Capture the microphone strictly in the side panel page (not content scripts)
 *   so microphone permission is stable and persistent.
 * - Format audio as raw 16-bit Linear PCM (mono, 16kHz) for Gnani Prisma STT streaming.
 * - Provide built-in browser SpeechRecognition fallback when no Gnani API key is configured.
 */

import { float32ToInt16PCM } from "../lib/gnani";

export type AudioChunkHandler = (pcmData: Int16Array) => void;
export type TranscriptHandler = (text: string, isFinal: boolean) => void;

export class MicrophoneSession {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private recognition: any = null;
  private isRecording = false;

  /**
   * Starts capturing microphone audio.
   * Feeds PCM chunks to Gnani Prisma STT if callback provided.
   * Runs browser SpeechRecognition concurrently or as fallback.
   */
  public async start(
    onPcmChunk: AudioChunkHandler,
    onTranscript: TranscriptHandler,
    languageCode: string = "hi-IN"
  ): Promise<void> {
    if (this.isRecording) return;

    // 1. Acquire microphone permission and stream
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.isRecording = true;

    // 2. Set up Web Audio pipeline for raw 16-bit PCM streaming (Gnani Prisma format)
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioCtx({ sampleRate: 16000 });
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Buffer size 2048 at 16kHz yields chunks of ~128ms
    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isRecording) return;
      const inputBuffer = event.inputBuffer.getChannelData(0);
      const pcm16 = float32ToInt16PCM(inputBuffer);
      onPcmChunk(pcm16);
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    // 3. Set up Browser Web Speech API as live transcription assistant / fallback
    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRec) {
      try {
        this.recognition = new SpeechRec();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = languageCode === "indic-auto" ? "hi-IN" : languageCode;

        this.recognition.onresult = (event: any) => {
          let interim = "";
          let finalTranscript = "";

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript;
            } else {
              interim += transcript;
            }
          }

          if (finalTranscript.trim()) {
            onTranscript(finalTranscript.trim(), true);
          } else if (interim.trim()) {
            onTranscript(interim.trim(), false);
          }
        };

        this.recognition.onerror = (err: any) => {
          console.warn("Browser SpeechRecognition notice:", err.error);
        };

        this.recognition.start();
      } catch (recErr) {
        console.warn("Could not start browser SpeechRecognition:", recErr);
      }
    }
  }

  /**
   * Stops microphone audio capture immediately.
   */
  public stop(): void {
    this.isRecording = false;

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // Ignore
      }
      this.recognition = null;
    }

    if (this.processorNode) {
      try {
        this.processorNode.disconnect();
      } catch {
        // Ignore
      }
      this.processorNode = null;
    }

    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore
      }
      this.sourceNode = null;
    }

    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch {
        // Ignore
      }
      this.audioContext = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore
        }
      }
      this.mediaStream = null;
    }
  }

  public isActive(): boolean {
    return this.isRecording;
  }
}
