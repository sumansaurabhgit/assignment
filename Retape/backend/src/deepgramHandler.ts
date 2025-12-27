/**
 * Deepgram Streaming Handler
 * 
 * Manages real-time Speech-to-Text transcription using Deepgram's streaming API.
 * 
 * KEY CONCEPTS:
 * - Processes audio in small chunks as they arrive
 * - Provides both partial (interim) and final transcripts
 * - Partial transcripts enable faster decision-making
 * - Final transcripts provide higher accuracy
 * 
 * WHY STREAMING STT:
 * In a real phone call, we can't wait for the entire voicemail greeting
 * to finish before starting transcription. We need to analyze speech
 * in real-time to detect when the greeting ends. Streaming STT gives us
 * partial results that we can use for LLM analysis immediately.
 */

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { EventEmitter } from 'events';
import { config } from './config';
import { TranscriptEvent } from './types';

export class DeepgramHandler extends EventEmitter {
  private client: ReturnType<typeof createClient>;
  private connection: any;
  private isConnected: boolean = false;
  private accumulatedTranscript: string = '';
  private currentTimestamp: number = 0;

  constructor() {
    super();
    this.client = createClient(config.deepgramApiKey);
  }

  /**
   * Initializes the Deepgram streaming connection.
   * 
   * Configuration choices:
   * - model: 'nova-2' - Best accuracy for general speech
   * - language: 'en' - English (can be made configurable)
   * - smart_format: true - Adds punctuation and formatting
   * - interim_results: true - Critical for real-time analysis
   * - endpointing: 300 - Detects speech endpoints for natural breaks
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.connection = this.client.listen.live({
          model: 'nova-2',
          language: 'en',
          smart_format: true,
          interim_results: true,
          punctuate: true,
          endpointing: 300,
          encoding: 'linear16',
          sample_rate: config.audio.sampleRate,
          channels: 1,
        });

        this.connection.on(LiveTranscriptionEvents.Open, () => {
          this.isConnected = true;
          console.log('[Deepgram] Connection opened');
          resolve();
        });

        this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
          this.handleTranscript(data);
        });

        this.connection.on(LiveTranscriptionEvents.Error, (error: Error) => {
          console.error('[Deepgram] Error:', error);
          this.emit('error', error);
        });

        this.connection.on(LiveTranscriptionEvents.Close, () => {
          this.isConnected = false;
          console.log('[Deepgram] Connection closed');
          this.emit('close');
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handles incoming transcript data from Deepgram.
   * 
   * Deepgram sends two types of transcripts:
   * 1. Interim (is_final: false) - Partial results, may change
   * 2. Final (is_final: true) - Confirmed results
   * 
   * We emit both types so the decision engine can:
   * - Use interim results for faster (but less certain) decisions
   * - Use final results for higher confidence analysis
   */
  private handleTranscript(data: any): void {
    const channel = data.channel;
    const alternatives = channel?.alternatives;

    if (!alternatives || alternatives.length === 0) return;

    const best = alternatives[0];
    const transcript = best.transcript || '';
    const isFinal = data.is_final || false;
    const confidence = best.confidence || 0;

    if (transcript.trim() === '') return;

    // For final transcripts, accumulate the text
    if (isFinal) {
      this.accumulatedTranscript += ' ' + transcript;
      this.accumulatedTranscript = this.accumulatedTranscript.trim();
    }

    const event: TranscriptEvent = {
      transcript: isFinal ? this.accumulatedTranscript : 
        this.accumulatedTranscript + ' ' + transcript,
      isFinal,
      confidence,
      timestamp: this.currentTimestamp,
    };

    this.emit('transcript', event);
  }

  /**
   * Sends an audio chunk to Deepgram for transcription.
   * 
   * @param samples - Float32Array of audio samples
   * @param timestamp - Current timestamp in the audio stream
   */
  sendAudio(samples: Float32Array, timestamp: number): void {
    if (!this.isConnected) {
      console.warn('[Deepgram] Not connected, dropping audio');
      return;
    }

    this.currentTimestamp = timestamp;

    // Convert Float32 samples to Int16 for Deepgram (linear16 encoding)
    const int16Samples = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      // Clamp and convert
      const s = Math.max(-1, Math.min(1, samples[i]));
      int16Samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Send as Buffer
    const buffer = Buffer.from(int16Samples.buffer);
    this.connection.send(buffer);
  }

  /**
   * Gets the accumulated transcript so far.
   */
  getAccumulatedTranscript(): string {
    return this.accumulatedTranscript;
  }

  /**
   * Resets the accumulated transcript.
   */
  resetTranscript(): void {
    this.accumulatedTranscript = '';
  }

  /**
   * Closes the Deepgram connection.
   */
  async close(): Promise<void> {
    if (this.connection && this.isConnected) {
      this.connection.finish();
      this.isConnected = false;
    }
  }
}

/**
 * Mock Deepgram handler for testing without API access.
 * 
 * This can be used during development or when API keys are not available.
 * It simulates transcript events based on timing patterns.
 */
export class MockDeepgramHandler extends EventEmitter {
  private accumulatedTranscript: string = '';
  private mockTranscripts: string[] = [
    "Hi",
    "Hi you've reached",
    "Hi you've reached John's voicemail",
    "Hi you've reached John's voicemail. I'm not available right now",
    "Hi you've reached John's voicemail. I'm not available right now. Please leave a message after the beep",
  ];
  private transcriptIndex: number = 0;
  private lastTranscriptTime: number = 0;

  async connect(): Promise<void> {
    console.log('[MockDeepgram] Connection simulated');
    return Promise.resolve();
  }

  sendAudio(samples: Float32Array, timestamp: number): void {
    // Simulate transcript progression every 500ms
    if (timestamp - this.lastTranscriptTime >= 0.5 && 
        this.transcriptIndex < this.mockTranscripts.length) {
      
      const transcript = this.mockTranscripts[this.transcriptIndex];
      this.accumulatedTranscript = transcript;
      
      const event: TranscriptEvent = {
        transcript,
        isFinal: this.transcriptIndex === this.mockTranscripts.length - 1,
        confidence: 0.95,
        timestamp,
      };

      this.emit('transcript', event);
      this.transcriptIndex++;
      this.lastTranscriptTime = timestamp;
    }
  }

  getAccumulatedTranscript(): string {
    return this.accumulatedTranscript;
  }

  resetTranscript(): void {
    this.accumulatedTranscript = '';
    this.transcriptIndex = 0;
  }

  async close(): Promise<void> {
    console.log('[MockDeepgram] Connection closed');
  }
}

/**
 * Factory function to create the appropriate handler.
 */
export function createDeepgramHandler(useMock: boolean = false): DeepgramHandler | MockDeepgramHandler {
  if (useMock || !config.deepgramApiKey) {
    console.log('[Deepgram] Using mock handler');
    return new MockDeepgramHandler();
  }
  return new DeepgramHandler();
}
