/**
 * OpenAI LLM Classifier
 * 
 * Uses OpenAI's language models for binary classification of voicemail greetings.
 * 
 * IMPORTANT DESIGN DECISION:
 * The LLM is used ONLY for semantic analysis, NOT for timing decisions.
 * 
 * The LLM's job is to answer a simple question:
 * "Has the speaker finished their voicemail greeting and is now
 *  expecting the caller to leave a message?"
 * 
 * This is purely a content analysis task. The actual timing decision
 * (when to start the voicemail) is made by the decision engine based on:
 * - LLM's semantic analysis (greeting complete?)
 * - Audio signals (silence detected?)
 * - Beep detection (overrides everything)
 * 
 * WHY BINARY CLASSIFICATION:
 * - Simpler = more reliable
 * - Faster response times
 * - Easier to validate and debug
 * - No ambiguity in interpretation
 */

import OpenAI from 'openai';
import { config } from './config';
import { LLMClassificationResult } from './types';

export class LLMClassifier {
  private client: OpenAI;
  private lastQueryTime: number = 0;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.openaiApiKey,
    });
  }

  /**
   * System prompt for the greeting completion classifier.
   * 
   * The prompt is designed to:
   * 1. Be extremely focused on a single task
   * 2. Handle partial transcripts gracefully
   * 3. Return only YES or NO for easy parsing
   */
  private readonly SYSTEM_PROMPT = `You are analyzing a voicemail greeting transcript.
Your task is to determine if the speaker has finished their voicemail greeting 
and is now expecting the caller to leave a message.

Signs that a greeting is COMPLETE:
- The speaker has introduced themselves or their business
- The speaker has acknowledged they can't answer
- The speaker has invited the caller to leave a message
- Phrases like "leave a message", "after the beep", "at the tone", "I'll get back to you"

Signs that a greeting is NOT complete:
- The transcript is very short or just starting
- The speaker is mid-sentence
- The speaker is still providing instructions or information
- No invitation to leave a message yet

IMPORTANT: You may receive partial transcripts. If the greeting seems incomplete
or you're uncertain, respond with NO.

You must respond with ONLY the word "YES" or "NO". No other text.`;

  /**
   * Classifies whether a voicemail greeting is complete.
   * 
   * @param transcript - The current transcript text
   * @param timestamp - Current timestamp for logging
   * @returns Classification result
   */
  async classifyGreeting(
    transcript: string,
    timestamp: number
  ): Promise<LLMClassificationResult> {
    // Check minimum transcript length
    if (transcript.length < config.llm.minTranscriptLength) {
      return {
        greetingComplete: false,
        rawResponse: 'SKIPPED_TOO_SHORT',
        timestamp,
      };
    }

    // Check cooldown to prevent excessive API calls
    const now = Date.now();
    if (now - this.lastQueryTime < config.llm.queryCooldownMs) {
      return {
        greetingComplete: false,
        rawResponse: 'SKIPPED_COOLDOWN',
        timestamp,
      };
    }

    this.lastQueryTime = now;

    try {
      console.log(`[LLM] Classifying transcript (${transcript.length} chars) at ${timestamp.toFixed(2)}s`);

      const response = await this.client.chat.completions.create({
        model: config.llm.model,
        messages: [
          { role: 'system', content: this.SYSTEM_PROMPT },
          { role: 'user', content: `Transcript: "${transcript}"` },
        ],
        max_tokens: 5, // We only need YES or NO
        temperature: 0, // Deterministic output
      });

      const rawResponse = response.choices[0]?.message?.content?.trim() || '';
      const greetingComplete = rawResponse.toUpperCase() === 'YES';

      console.log(`[LLM] Response: ${rawResponse} (greeting complete: ${greetingComplete})`);

      return {
        greetingComplete,
        rawResponse,
        timestamp,
      };
    } catch (error) {
      console.error('[LLM] Classification error:', error);
      return {
        greetingComplete: false,
        rawResponse: `ERROR: ${error}`,
        timestamp,
      };
    }
  }

  /**
   * Resets the query cooldown timer.
   * Used when starting a new audio analysis session.
   */
  resetCooldown(): void {
    this.lastQueryTime = 0;
  }
}

/**
 * Mock LLM Classifier for testing without API access.
 * 
 * Simulates LLM responses based on transcript content patterns.
 */
export class MockLLMClassifier {
  private lastQueryTime: number = 0;

  async classifyGreeting(
    transcript: string,
    timestamp: number
  ): Promise<LLMClassificationResult> {
    // Check minimum transcript length
    if (transcript.length < config.llm.minTranscriptLength) {
      return {
        greetingComplete: false,
        rawResponse: 'SKIPPED_TOO_SHORT',
        timestamp,
      };
    }

    // Check cooldown
    const now = Date.now();
    if (now - this.lastQueryTime < config.llm.queryCooldownMs) {
      return {
        greetingComplete: false,
        rawResponse: 'SKIPPED_COOLDOWN',
        timestamp,
      };
    }

    this.lastQueryTime = now;

    // Simple heuristic-based classification
    const lowerTranscript = transcript.toLowerCase();
    const completionPhrases = [
      'leave a message',
      'leave your message',
      'after the beep',
      'at the tone',
      "i'll get back to you",
      "we'll get back to you",
      'please leave',
      'not available',
      "can't come to the phone",
      'unable to take your call',
    ];

    const greetingComplete = completionPhrases.some(phrase => 
      lowerTranscript.includes(phrase)
    );

    console.log(`[MockLLM] Transcript: "${transcript.substring(0, 50)}..." -> ${greetingComplete ? 'YES' : 'NO'}`);

    return {
      greetingComplete,
      rawResponse: greetingComplete ? 'YES' : 'NO',
      timestamp,
    };
  }

  resetCooldown(): void {
    this.lastQueryTime = 0;
  }
}

/**
 * Factory function to create the appropriate classifier.
 */
export function createLLMClassifier(useMock: boolean = false): LLMClassifier | MockLLMClassifier {
  if (useMock || !config.openaiApiKey) {
    console.log('[LLM] Using mock classifier');
    return new MockLLMClassifier();
  }
  return new LLMClassifier();
}
