/**
 * Voicemail Decision Engine
 * 
 * This is the core decision-making component that orchestrates all signals
 * (beep detection, speech analysis, silence detection) to determine the
 * optimal timestamp to start playing a voicemail message.
 * 
 * ============================================================================
 * SIGNAL PRIORITY HIERARCHY (STRICTLY ENFORCED)
 * ============================================================================
 * 
 * Priority 1: BEEP DETECTION (Highest - Always Final)
 *    - A beep is an unambiguous signal that the voicemail system is ready
 *    - If detected, it ALWAYS overrides ALL other signals
 *    - The voicemail MUST start/restart at the beep timestamp
 *    - This is the ONLY signal that produces a FINAL decision
 * 
 * Priority 2: LLM CONFIRMATION + SHORT SILENCE
 *    - If the LLM confirms the greeting is complete AND
 *    - A short period of silence follows (300-500ms)
 *    - This produces a CANDIDATE decision (not final)
 * 
 * Priority 3: SUSTAINED SILENCE FALLBACK (Lowest)
 *    - If extended silence (1200ms+) is detected
 *    - Used when there's no beep and LLM hasn't confirmed
 *    - This produces a CANDIDATE decision (not final)
 * 
 * ============================================================================
 * CANDIDATE vs FINAL DECISIONS
 * ============================================================================
 * 
 * CANDIDATE DECISION:
 *   - Produced by silence or LLM+silence signals
 *   - Triggers voicemail streaming to BEGIN
 *   - Can be OVERRIDDEN if a beep is detected later
 *   - Consumer may NOT actually hear content played during this time
 * 
 * FINAL DECISION:
 *   - Produced ONLY by beep detection OR end of audio stream
 *   - If beep: voicemail MUST restart from beep timestamp
 *   - If end of stream with no beep: candidate becomes final
 * 
 * ============================================================================
 * CRITICAL COMPLIANCE RULE
 * ============================================================================
 * 
 * If a voicemail beep occurs, the consumer CANNOT hear anything spoken
 * before the beep. The beep boundary defines what the consumer actually hears.
 * 
 * Therefore:
 *   - Voicemail playback that begins during silence is NOT audible if a beep
 *     occurs later
 *   - When beep is detected after a candidate start, we MUST:
 *     1. Emit 'restart' event to signal the caller
 *     2. Discard the earlier silence/LLM start
 *     3. Use beep timestamp as the FINAL authoritative start
 * 
 * ============================================================================
 * EDGE CASE: SILENCE THEN BEEP
 * ============================================================================
 * 
 * Scenario: Greeting ends → several seconds of silence → THEN beep occurs
 * 
 * Timeline:
 *   0.0s - Greeting starts
 *   3.0s - Greeting ends
 *   3.5s - Silence detected, CANDIDATE start triggered → emit 'candidate_start'
 *   3.5s - Caller begins streaming voicemail
 *   5.0s - BEEP DETECTED → emit 'restart' with beep timestamp
 *   5.0s - Caller MUST restart voicemail streaming from beginning
 *   5.0s - FINAL decision locked at beep timestamp
 * 
 * ============================================================================
 * EVENTS EMITTED
 * ============================================================================
 * 
 * 'candidate_start' - Silence/LLM triggered a candidate start (begin streaming)
 *    payload: { timestamp, reason, isFinal: false }
 * 
 * 'restart' - Beep detected after candidate, must restart streaming
 *    payload: { timestamp, reason: 'beep', previousTimestamp }
 * 
 * 'final_decision' - Processing complete, decision is final
 *    payload: DetectionResult
 * 
 * ============================================================================
 */

import { EventEmitter } from 'events';
import { config } from './config';
import { analyzeFrame } from './audioUtils';
import { createDeepgramHandler, DeepgramHandler, MockDeepgramHandler } from './deepgramHandler';
import { createLLMClassifier, LLMClassifier, MockLLMClassifier } from './llmClassifier';
import { 
  DetectionResult, 
  DetectionState, 
  FrameAnalysis, 
  TranscriptEvent,
  DetectionReason 
} from './types';

/**
 * Signal priority levels - lower number = higher priority
 * This makes the priority hierarchy explicit and easy to reason about
 */
enum SignalPriority {
  BEEP = 1,           // Highest priority - always final
  LLM_SILENCE = 2,    // Medium priority - candidate only
  SILENCE_FALLBACK = 3 // Lowest priority - candidate only
}

/**
 * Maps detection reasons to their priority levels
 */
const REASON_TO_PRIORITY: Record<DetectionReason, SignalPriority> = {
  'beep': SignalPriority.BEEP,
  'llm_silence': SignalPriority.LLM_SILENCE,
  'silence_fallback': SignalPriority.SILENCE_FALLBACK,
};

/**
 * Candidate decision that may be overridden by higher priority signals
 */
interface CandidateDecision {
  timestamp: number;
  reason: DetectionReason;
  priority: SignalPriority;
  emittedAt: number; // When we emitted candidate_start
}

export class VoicemailDecisionEngine extends EventEmitter {
  private deepgram: DeepgramHandler | MockDeepgramHandler;
  private llm: LLMClassifier | MockLLMClassifier;
  private state: DetectionState;
  private useMock: boolean;

  /**
   * Current candidate decision that can be overridden by beep
   * 
   * KEY CONCEPT: A candidate decision means we've started streaming
   * the voicemail, but we're NOT committed to this start time yet.
   * If a beep occurs later, we MUST restart from the beep.
   */
  private candidateDecision: CandidateDecision | null = null;

  /**
   * Whether voicemail streaming has been triggered (candidate or final)
   * This is used to know if we need to emit 'restart' on beep detection
   */
  private streamingStarted: boolean = false;

  /**
   * Final decision - once set, no more processing needed
   * Only beep detection or end-of-stream can set this
   */
  private finalDecision: DetectionResult | null = null;

  // Buffer to collect audio for context
  private recentFrames: FrameAnalysis[] = [];
  private readonly FRAME_BUFFER_SIZE = 50; // Keep last ~2.5 seconds at 50ms frames

  /**
   * BEEP TEMPORAL CONSISTENCY TRACKING
   * 
   * WHY THIS IS NEEDED:
   * Speech can momentarily produce energy in the beep frequency range,
   * especially high-pitched vowels or certain consonants. However, these
   * are brief (10-30ms) while real beeps are sustained (100-500ms+).
   * 
   * STRATEGY:
   * - Count consecutive frames where beep is detected
   * - Only confirm beep after MIN_CONSECUTIVE_BEEP_FRAMES consecutive detections
   * - Reset counter when a non-beep frame is encountered
   * 
   * At 50ms per frame:
   * - 2 frames = 100ms (minimum beep)
   * - 3 frames = 150ms (confident)
   * - 4 frames = 200ms (very confident)
   */
  private consecutiveBeepFrames: number = 0;
  private beepStartTimestamp: number | null = null;
  private readonly MIN_CONSECUTIVE_BEEP_FRAMES = 3; // Require 150ms of sustained beep

  constructor(useMock: boolean = false) {
    super();
    this.useMock = useMock;
    this.deepgram = createDeepgramHandler(useMock);
    this.llm = createLLMClassifier(useMock);
    this.state = this.createInitialState();

    // Set up transcript event handling
    this.deepgram.on('transcript', (event: TranscriptEvent) => {
      this.handleTranscript(event);
    });
  }

  /**
   * Creates a fresh initial state for detection.
   */
  private createInitialState(): DetectionState {
    return {
      currentTimestamp: 0,
      silenceStartTimestamp: null,
      transcript: '',
      llmConfirmedGreetingEnd: false,
      llmConfirmationTimestamp: null,
      beepDetected: false,
      beepTimestamp: null,
      finalized: false,
      result: null,
    };
  }

  /**
   * Initializes the decision engine and connects to services.
   */
  async initialize(): Promise<void> {
    console.log('[DecisionEngine] Initializing...');
    await this.deepgram.connect();
    this.llm.resetCooldown();
    this.state = this.createInitialState();
    this.candidateDecision = null;
    this.finalDecision = null;
    this.streamingStarted = false;
    this.recentFrames = [];
    this.consecutiveBeepFrames = 0;
    this.beepStartTimestamp = null;
    console.log('[DecisionEngine] Ready');
  }

  /**
   * Processes a single audio frame through the detection pipeline.
   * 
   * This is the main entry point for streaming audio analysis.
   * Each frame is analyzed for:
   * 1. Beep presence (FFT analysis) - HIGHEST PRIORITY
   * 2. Silence (RMS energy)
   * 3. Speech content (via Deepgram)
   * 
   * IMPORTANT: Processing continues even after a candidate decision
   * because a beep can still override it.
   * 
   * @param samples - Audio samples for this frame
   * @param timestamp - Frame timestamp in seconds
   * @param sampleRate - Audio sample rate
   * @returns Detection result if finalized, null otherwise
   */
  async processFrame(
    samples: Float32Array,
    timestamp: number,
    sampleRate: number
  ): Promise<DetectionResult | null> {
    // If we have a final decision (beep was detected), return it
    if (this.finalDecision) {
      return this.finalDecision;
    }

    this.state.currentTimestamp = timestamp;

    // Step 1: Analyze the audio frame for beep and silence
    const frameAnalysis = analyzeFrame(samples, timestamp, sampleRate);
    
    // Store in recent frames buffer for context
    this.recentFrames.push(frameAnalysis);
    if (this.recentFrames.length > this.FRAME_BUFFER_SIZE) {
      this.recentFrames.shift();
    }

    // Emit frame analysis for debugging/monitoring
    this.emit('frame', frameAnalysis);

    // Step 2: Send audio to Deepgram for transcription
    this.deepgram.sendAudio(samples, timestamp);

    // =========================================================================
    // Step 3: CHECK FOR BEEP (PRIORITY 1 - HIGHEST)
    // =========================================================================
    // WHY BEEP ALWAYS OVERRIDES EVERYTHING:
    // 
    // The beep marks when the voicemail system actually starts recording.
    // Anything played BEFORE the beep is NOT heard by the consumer.
    // 
    // Compliance requirement: The consumer must hear the company name and
    // callback number. If we start playing during silence before a beep,
    // and then a beep occurs, the consumer missed our compliance message.
    // 
    // Therefore: When beep is detected, we MUST restart from the beep,
    // regardless of any earlier candidate decision.
    // 
    // TEMPORAL CONSISTENCY:
    // We require MIN_CONSECUTIVE_BEEP_FRAMES consecutive frames with beep
    // to confirm detection. This prevents false positives from speech
    // harmonics which are brief (10-30ms) compared to real beeps (100-500ms+).
    // =========================================================================
    if (frameAnalysis.beepDetected) {
      // Increment consecutive beep counter
      this.consecutiveBeepFrames++;
      
      // Record when the potential beep started
      if (this.beepStartTimestamp === null) {
        this.beepStartTimestamp = timestamp;
        console.log(`[DecisionEngine] 🎵 Potential beep started at ${timestamp.toFixed(3)}s (frame 1/${this.MIN_CONSECUTIVE_BEEP_FRAMES})`);
      } else {
        console.log(`[DecisionEngine] 🎵 Beep continues at ${timestamp.toFixed(3)}s (frame ${this.consecutiveBeepFrames}/${this.MIN_CONSECUTIVE_BEEP_FRAMES})`);
      }
      
      // Check if we've seen enough consecutive beep frames
      if (this.consecutiveBeepFrames >= this.MIN_CONSECUTIVE_BEEP_FRAMES && !this.state.beepDetected) {
        console.log(`[DecisionEngine] ✅ BEEP CONFIRMED after ${this.consecutiveBeepFrames} consecutive frames`);
        return this.handleBeepDetected(this.beepStartTimestamp!);
      }
    } else {
      // Not a beep frame - reset the counter
      if (this.consecutiveBeepFrames > 0) {
        console.log(`[DecisionEngine] 🔇 Beep interrupted after ${this.consecutiveBeepFrames} frames (needed ${this.MIN_CONSECUTIVE_BEEP_FRAMES})`);
      }
      this.consecutiveBeepFrames = 0;
      this.beepStartTimestamp = null;
    }

    // Step 4: Track silence periods
    this.updateSilenceTracking(frameAnalysis);

    // Step 5: Check for candidate decision triggers (lower priority signals)
    // NOTE: We only check these if we don't already have a candidate
    // and we haven't detected a beep yet
    if (!this.candidateDecision && !this.state.beepDetected) {
      await this.checkCandidateDecisionTriggers(timestamp);
    }

    return null; // Not finalized yet - continue processing
  }

  /**
   * Handles beep detection - the highest priority signal.
   * 
   * COMPLIANCE CRITICAL:
   * The beep marks when recording actually starts. Anything played
   * before the beep is NOT heard by the consumer. We MUST restart
   * voicemail playback from the beep timestamp.
   * 
   * @param timestamp - When the beep was detected
   * @returns Final detection result
   */
  private handleBeepDetected(timestamp: number): DetectionResult {
    console.log(`[DecisionEngine] 🔔 BEEP DETECTED at ${timestamp.toFixed(3)}s`);
    console.log(`[DecisionEngine] Priority: ${SignalPriority.BEEP} (HIGHEST - ALWAYS FINAL)`);

    this.state.beepDetected = true;
    this.state.beepTimestamp = timestamp;

    // Check if we had a candidate decision that was already streaming
    if (this.candidateDecision && this.streamingStarted) {
      // =====================================================================
      // CRITICAL: RESTART REQUIRED
      // =====================================================================
      // We were already streaming voicemail based on silence/LLM detection,
      // but now a beep occurred. The consumer couldn't hear what we played
      // before the beep. We MUST restart from the beep timestamp.
      // =====================================================================
      console.log(`[DecisionEngine] ⚠️  RESTART REQUIRED!`);
      console.log(`[DecisionEngine] Previous candidate was at ${this.candidateDecision.timestamp.toFixed(3)}s (${this.candidateDecision.reason})`);
      console.log(`[DecisionEngine] Beep overrides - restarting from ${timestamp.toFixed(3)}s`);

      // Emit restart event so caller knows to restart streaming
      this.emit('restart', {
        timestamp,
        reason: 'beep' as DetectionReason,
        previousTimestamp: this.candidateDecision.timestamp,
        previousReason: this.candidateDecision.reason,
        message: 'Beep detected after candidate start - voicemail must restart from beep',
      });
    }

    // Clear any candidate decision - beep takes over
    this.candidateDecision = null;

    // Create final result
    this.finalDecision = this.createFinalResult(timestamp, 'beep');
    this.state.finalized = true;
    this.state.result = this.finalDecision;

    // Emit final decision event
    this.emit('final_decision', this.finalDecision);
    this.emit('decision', this.finalDecision); // Keep backward compatibility

    console.log(`[DecisionEngine] ✅ FINAL DECISION: beep at ${timestamp.toFixed(3)}s`);

    return this.finalDecision;
  }

  /**
   * Updates silence tracking state based on frame analysis.
   */
  private updateSilenceTracking(frame: FrameAnalysis): void {
    if (frame.isSilence) {
      // Start tracking silence if not already
      if (this.state.silenceStartTimestamp === null) {
        this.state.silenceStartTimestamp = frame.timestamp;
        console.log(`[DecisionEngine] Silence started at ${frame.timestamp.toFixed(3)}s`);
      }
    } else {
      // Reset silence tracking on non-silent audio
      if (this.state.silenceStartTimestamp !== null) {
        const duration = frame.timestamp - this.state.silenceStartTimestamp;
        console.log(`[DecisionEngine] Silence ended after ${duration.toFixed(3)}s`);
      }
      this.state.silenceStartTimestamp = null;
    }
  }

  /**
   * Checks for candidate decision triggers (Priority 2 and 3 signals).
   * 
   * These are LOWER priority than beep and produce CANDIDATE decisions
   * that can be overridden if a beep is detected later.
   * 
   * The candidate triggers voicemail streaming to begin, but the caller
   * must be prepared to restart if a 'restart' event is emitted.
   */
  private async checkCandidateDecisionTriggers(timestamp: number): Promise<void> {
    const currentSilenceDuration = this.state.silenceStartTimestamp !== null
      ? timestamp - this.state.silenceStartTimestamp
      : 0;

    // =========================================================================
    // PRIORITY 2: LLM confirmation + short silence
    // =========================================================================
    // If the LLM has confirmed the greeting is complete AND we detect
    // a short silence (300-500ms), this is a strong signal that the
    // greeting has ended. However, it's still just a CANDIDATE because
    // a beep could still occur.
    // =========================================================================
    if (this.state.llmConfirmedGreetingEnd && 
        currentSilenceDuration >= config.silence.shortDurationMs / 1000) {
      
      this.triggerCandidateDecision(
        this.state.silenceStartTimestamp!,
        'llm_silence',
        SignalPriority.LLM_SILENCE
      );
      return;
    }

    // =========================================================================
    // PRIORITY 3: Sustained silence fallback
    // =========================================================================
    // If we detect extended silence without a beep or LLM confirmation,
    // this is our lowest-confidence signal. Still just a CANDIDATE.
    // =========================================================================
    if (currentSilenceDuration >= config.silence.longDurationMs / 1000) {
      this.triggerCandidateDecision(
        this.state.silenceStartTimestamp!,
        'silence_fallback',
        SignalPriority.SILENCE_FALLBACK
      );
    }
  }

  /**
   * Triggers a candidate decision and emits event to start streaming.
   * 
   * IMPORTANT: This is NOT a final decision. The caller should start
   * streaming voicemail, but must listen for 'restart' event in case
   * a beep is detected later.
   */
  private triggerCandidateDecision(
    timestamp: number,
    reason: DetectionReason,
    priority: SignalPriority
  ): void {
    // Don't trigger if we already have a candidate
    if (this.candidateDecision) {
      return;
    }

    console.log(`[DecisionEngine] 📋 CANDIDATE DECISION: ${reason} at ${timestamp.toFixed(3)}s`);
    console.log(`[DecisionEngine] Priority: ${priority} (${this.getPriorityName(priority)})`);
    console.log(`[DecisionEngine] ⚠️  This is NOT final - beep can still override`);

    this.candidateDecision = {
      timestamp,
      reason,
      priority,
      emittedAt: Date.now(),
    };

    this.streamingStarted = true;

    // Emit candidate_start event so caller can begin streaming
    // The caller MUST be prepared to handle 'restart' if beep occurs later
    this.emit('candidate_start', {
      timestamp,
      reason,
      priority,
      isFinal: false,
      message: `Candidate start based on ${reason} - begin streaming but be ready to restart on beep`,
    });
  }

  /**
   * Gets human-readable priority name for logging
   */
  private getPriorityName(priority: SignalPriority): string {
    switch (priority) {
      case SignalPriority.BEEP: return 'HIGHEST - ALWAYS FINAL';
      case SignalPriority.LLM_SILENCE: return 'MEDIUM - CANDIDATE ONLY';
      case SignalPriority.SILENCE_FALLBACK: return 'LOWEST - CANDIDATE ONLY';
      default: return 'UNKNOWN';
    }
  }

  /**
   * Handles transcript events from Deepgram.
   * Triggers LLM classification when appropriate.
   */
  private async handleTranscript(event: TranscriptEvent): Promise<void> {
    this.state.transcript = event.transcript;
    
    this.emit('transcript', event);

    // Don't query LLM if already confirmed or if we have a final decision
    if (this.state.llmConfirmedGreetingEnd || this.finalDecision) {
      return;
    }

    // Query LLM for greeting completion classification
    const result = await this.llm.classifyGreeting(event.transcript, event.timestamp);
    
    this.emit('llm', result);

    if (result.greetingComplete) {
      console.log(`[DecisionEngine] 🤖 LLM confirmed greeting complete at ${event.timestamp.toFixed(3)}s`);
      this.state.llmConfirmedGreetingEnd = true;
      this.state.llmConfirmationTimestamp = event.timestamp;
    }
  }

  /**
   * Creates a final detection result.
   */
  private createFinalResult(
    timestamp: number,
    reason: DetectionReason
  ): DetectionResult {
    const explanations: Record<DetectionReason, string> = {
      beep: 'Voicemail beep detected - this is the authoritative start time (consumer hears from here)',
      llm_silence: 'LLM confirmed greeting complete and silence detected - finalized as no beep occurred',
      silence_fallback: 'Extended silence detected and no beep occurred - finalized as fallback',
    };

    return {
      detected: true,
      timestamp,
      reason,
      explanation: explanations[reason],
      debug: {
        beepDetectedAt: this.state.beepTimestamp || undefined,
        silenceStartedAt: this.state.silenceStartTimestamp || undefined,
        silenceDuration: this.state.silenceStartTimestamp 
          ? this.state.currentTimestamp - this.state.silenceStartTimestamp 
          : undefined,
        llmConfirmedAt: this.state.llmConfirmationTimestamp || undefined,
        transcript: this.state.transcript,
      },
    };
  }

  /**
   * Finalizes the detection when audio stream ends.
   * 
   * Called when all audio has been processed. If we have a candidate
   * decision but no beep was detected, the candidate becomes final.
   * 
   * @returns Final detection result
   */
  finalizeAtEndOfStream(): DetectionResult {
    // If we already have a final decision (beep was detected), return it
    if (this.finalDecision) {
      return this.finalDecision;
    }

    // If we have a candidate decision, promote it to final
    // (No beep occurred, so the candidate is our best answer)
    if (this.candidateDecision) {
      console.log(`[DecisionEngine] End of stream - promoting candidate to final`);
      console.log(`[DecisionEngine] No beep detected - ${this.candidateDecision.reason} at ${this.candidateDecision.timestamp.toFixed(3)}s is now final`);

      this.finalDecision = this.createFinalResult(
        this.candidateDecision.timestamp,
        this.candidateDecision.reason
      );
      this.state.finalized = true;
      this.state.result = this.finalDecision;

      this.emit('final_decision', this.finalDecision);
      this.emit('decision', this.finalDecision);

      return this.finalDecision;
    }

    // No decision was made at all
    console.log('[DecisionEngine] End of stream - no detection made');
    return this.getNoDetectionResult();
  }

  /**
   * Gets a result indicating no detection occurred.
   * Used when audio stream ends without a trigger.
   */
  getNoDetectionResult(): DetectionResult {
    return {
      detected: false,
      timestamp: this.state.currentTimestamp,
      reason: null,
      explanation: 'No voicemail trigger detected in audio stream',
      debug: {
        transcript: this.state.transcript,
      },
    };
  }

  /**
   * Cleans up resources.
   */
  async cleanup(): Promise<void> {
    await this.deepgram.close();
    this.state = this.createInitialState();
    this.candidateDecision = null;
    this.finalDecision = null;
    this.streamingStarted = false;
    this.recentFrames = [];
    console.log('[DecisionEngine] Cleaned up');
  }

  /**
   * Gets the current state for debugging.
   */
  getState(): DetectionState {
    return { ...this.state };
  }

  /**
   * Gets the current candidate decision if any.
   */
  getCandidateDecision(): CandidateDecision | null {
    return this.candidateDecision ? { ...this.candidateDecision } : null;
  }

  /**
   * Gets whether streaming has started (candidate or final).
   */
  hasStreamingStarted(): boolean {
    return this.streamingStarted;
  }

  /**
   * Gets whether the decision is final (beep detected or stream ended).
   */
  isFinal(): boolean {
    return this.finalDecision !== null;
  }
}
