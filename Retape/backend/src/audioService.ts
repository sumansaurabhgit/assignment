/**
 * Audio Processing Service
 * 
 * Orchestrates the streaming audio processing pipeline.
 * This service takes an uploaded WAV file and processes it
 * through the decision engine in a streaming fashion.
 * 
 * HOW STREAMING IS SIMULATED FROM UPLOADED FILES:
 * ================================================
 * In production, audio would arrive in real-time from a phone call.
 * For this demo/test environment, we simulate streaming by:
 * 
 * 1. Reading the WAV file header to understand the format
 * 2. Calculating the frame size (e.g., 50ms of audio)
 * 3. Iterating through the file one frame at a time
 * 4. Processing each frame through the decision engine
 * 5. Adding small delays between frames to simulate real-time
 * 
 * This allows us to test the streaming detection logic without
 * needing an actual phone line, while ensuring the algorithm
 * would work correctly in a real telephony environment.
 * 
 * ============================================================================
 * HANDLING CANDIDATE vs FINAL DECISIONS
 * ============================================================================
 * 
 * The decision engine emits three types of events:
 * 
 * 1. 'candidate_start' - Silence/LLM triggered a candidate start
 *    - Begin streaming voicemail to the consumer
 *    - BUT be prepared to restart if beep occurs
 * 
 * 2. 'restart' - Beep detected after candidate start
 *    - MUST restart voicemail streaming from the beginning
 *    - The beep timestamp is now the authoritative start
 * 
 * 3. 'final_decision' - Decision is now final
 *    - Either beep was detected OR end of stream with no beep
 *    - No more changes will occur
 * 
 * In a real telephony system, you would:
 * - On 'candidate_start': Begin playing the voicemail
 * - On 'restart': Stop playback, restart from beginning at beep time
 * - On 'final_decision': Commit to the final timestamp
 * 
 * ============================================================================
 */

import { streamAudioFrames } from './audioUtils';
import { VoicemailDecisionEngine } from './decisionEngine';
import { config } from './config';
import { DetectionResult, FrameAnalysis, TranscriptEvent, LLMClassificationResult } from './types';

export interface ProcessingProgress {
  currentTime: number;
  totalDuration: number;
  percentComplete: number;
  frameAnalysis?: FrameAnalysis;
  transcript?: string;
  llmResult?: LLMClassificationResult;
}

/**
 * Event emitted when a candidate start is detected
 */
export interface CandidateStartEvent {
  timestamp: number;
  reason: string;
  isFinal: false;
  message: string;
}

/**
 * Event emitted when a restart is required (beep after candidate)
 */
export interface RestartEvent {
  timestamp: number;
  reason: 'beep';
  previousTimestamp: number;
  previousReason: string;
  message: string;
}

export interface ProcessingOptions {
  // Whether to use mock services (for testing without API keys)
  useMock?: boolean;
  
  // Whether to simulate real-time processing (adds delays)
  simulateRealTime?: boolean;
  
  // Callback for progress updates
  onProgress?: (progress: ProcessingProgress) => void;
  
  // Callback for frame analysis
  onFrame?: (frame: FrameAnalysis) => void;
  
  // Callback for transcript updates
  onTranscript?: (event: TranscriptEvent) => void;

  // Callback when candidate start is detected (begin streaming voicemail)
  onCandidateStart?: (event: CandidateStartEvent) => void;

  // Callback when restart is required (beep detected after candidate)
  // In a real system, you would restart voicemail playback here
  onRestart?: (event: RestartEvent) => void;
}

/**
 * Extended result that includes streaming events that occurred
 */
export interface ProcessingResult {
  result: DetectionResult;
  processingTime: number;
  streamingEvents: {
    candidateStarted: boolean;
    candidateTimestamp?: number;
    candidateReason?: string;
    restartOccurred: boolean;
    restartTimestamp?: number;
    finalTimestamp: number;
    finalReason: string | null;
  };
}

/**
 * Processes a WAV file buffer through the voicemail detection pipeline.
 * 
 * @param audioBuffer - Buffer containing the WAV file data
 * @param options - Processing options
 * @returns Detection result with streaming event information
 */
export async function processAudioFile(
  audioBuffer: Buffer,
  options: ProcessingOptions = {}
): Promise<DetectionResult> {
  const {
    useMock = false,
    simulateRealTime = false,
    onProgress,
    onFrame,
    onTranscript,
    onCandidateStart,
    onRestart,
  } = options;

  console.log(`[AudioService] Processing audio file (${audioBuffer.length} bytes)`);
  console.log(`[AudioService] Options: useMock=${useMock}, simulateRealTime=${simulateRealTime}`);

  // Create and initialize the decision engine
  const engine = new VoicemailDecisionEngine(useMock);

  // Track streaming events for the result
  let candidateStartEvent: CandidateStartEvent | null = null;
  let restartEvent: RestartEvent | null = null;

  // Set up event listeners
  if (onFrame) {
    engine.on('frame', onFrame);
  }

  if (onTranscript) {
    engine.on('transcript', onTranscript);
  }

  // =========================================================================
  // CANDIDATE START EVENT
  // =========================================================================
  // This is triggered when silence or LLM+silence is detected.
  // In a real telephony system, this is when you would START streaming
  // the voicemail message to the consumer.
  // 
  // IMPORTANT: This is NOT final! A beep may still occur.
  // =========================================================================
  engine.on('candidate_start', (event) => {
    const candidateEvent = event as CandidateStartEvent;
    console.log(`[AudioService] 📋 CANDIDATE START: ${candidateEvent.reason} at ${candidateEvent.timestamp.toFixed(3)}s`);
    console.log(`[AudioService] ⚠️  Begin streaming voicemail - but be ready to restart on beep!`);
    
    candidateStartEvent = candidateEvent;
    
    if (onCandidateStart) {
      onCandidateStart(candidateEvent);
    }
  });

  // =========================================================================
  // RESTART EVENT
  // =========================================================================
  // This is triggered when a beep is detected AFTER a candidate start.
  // In a real telephony system, this means:
  //   - The voicemail we were playing is NOT being heard by the consumer
  //   - We MUST restart from the beginning at the beep timestamp
  //   - The beep timestamp is now the authoritative start time
  // 
  // COMPLIANCE CRITICAL: If we don't restart, the consumer won't hear
  // the required company name and callback number!
  // =========================================================================
  engine.on('restart', (event) => {
    const restartEvt = event as RestartEvent;
    console.log(`[AudioService] 🔄 RESTART REQUIRED!`);
    console.log(`[AudioService] Beep detected at ${restartEvt.timestamp.toFixed(3)}s`);
    console.log(`[AudioService] Previous candidate at ${restartEvt.previousTimestamp.toFixed(3)}s is INVALID`);
    console.log(`[AudioService] Consumer could NOT hear voicemail played before beep`);
    console.log(`[AudioService] MUST restart voicemail streaming from beginning!`);
    
    restartEvent = restartEvt;
    
    if (onRestart) {
      onRestart(restartEvt);
    }
  });

  try {
    await engine.initialize();

    // Calculate total duration for progress reporting
    const totalFrames = Math.ceil(
      audioBuffer.length / (config.audio.sampleRate * 2 * config.audio.frameSizeMs / 1000)
    );
    const totalDuration = (totalFrames * config.audio.frameSizeMs) / 1000;

    let frameCount = 0;

    // =========================================================================
    // STREAM PROCESSING LOOP
    // =========================================================================
    // We process the entire audio file frame by frame, even after a candidate
    // decision is made, because a beep can still occur and override it.
    // 
    // Only when a beep is detected (which is FINAL) do we stop early.
    // =========================================================================
    for await (const frame of streamAudioFrames(audioBuffer, config.audio.frameSizeMs)) {
      frameCount++;

      // Process this frame through the decision engine
      const result = await engine.processFrame(frame.samples, frame.timestamp, frame.sampleRate);

      // Report progress
      if (onProgress) {
        const progress: ProcessingProgress = {
          currentTime: frame.timestamp,
          totalDuration,
          percentComplete: (frameCount / totalFrames) * 100,
          transcript: engine.getState().transcript,
        };
        onProgress(progress);
      }

      // If beep was detected (final decision), we can stop processing
      // Beep is the only signal that produces an immediate final result
      if (result && result.reason === 'beep') {
        console.log(`[AudioService] Beep detected - stopping processing`);
        break;
      }

      // Simulate real-time processing if requested
      if (simulateRealTime) {
        await sleep(config.audio.frameSizeMs);
      }
    }

    // =========================================================================
    // FINALIZE AT END OF STREAM
    // =========================================================================
    // If we reach here, either:
    // 1. A beep was detected (result already set)
    // 2. Audio ended with a candidate decision (needs to be promoted to final)
    // 3. Audio ended with no decision at all
    // =========================================================================
    const finalResult = engine.finalizeAtEndOfStream();

    // Log summary
    console.log(`[AudioService] ========== PROCESSING COMPLETE ==========`);
    console.log(`[AudioService] Final result: ${finalResult.detected ? finalResult.reason : 'no detection'} at ${finalResult.timestamp.toFixed(3)}s`);
    
    if (candidateStartEvent !== null) {
      const candidate = candidateStartEvent as CandidateStartEvent;
      console.log(`[AudioService] Candidate was started at: ${candidate.timestamp.toFixed(3)}s (${candidate.reason})`);
    }
    
    if (restartEvent !== null) {
      const restart = restartEvent as RestartEvent;
      console.log(`[AudioService] ⚠️  RESTART occurred - beep overrode candidate`);
      console.log(`[AudioService] Voicemail should have restarted at: ${restart.timestamp.toFixed(3)}s`);
    }
    
    console.log(`[AudioService] ===========================================`);

    return finalResult;
  } finally {
    // Always clean up
    await engine.cleanup();
  }
}

/**
 * Helper function for delays.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validates that a buffer appears to be a valid WAV file.
 */
export function validateWavFile(buffer: Buffer): { valid: boolean; error?: string } {
  if (buffer.length < 44) {
    return { valid: false, error: 'File too small to be a valid WAV file' };
  }

  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') {
    return { valid: false, error: 'Missing RIFF header - not a valid WAV file' };
  }

  const wave = buffer.toString('ascii', 8, 12);
  if (wave !== 'WAVE') {
    return { valid: false, error: 'Missing WAVE format identifier' };
  }

  return { valid: true };
}
