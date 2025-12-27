/**
 * Type Definitions for Voicemail Detection System
 */

/**
 * Reason for triggering voicemail start
 */
export type DetectionReason = 'beep' | 'llm_silence' | 'silence_fallback';

/**
 * Result of voicemail detection analysis
 */
export interface DetectionResult {
  // Whether a trigger point was detected
  detected: boolean;
  
  // Timestamp in seconds where voicemail should start
  timestamp: number;
  
  // The reason for detection
  reason: DetectionReason | null;
  
  // Human-readable explanation
  explanation: string;
  
  // Additional debug information
  debug?: {
    beepDetectedAt?: number;
    silenceStartedAt?: number;
    silenceDuration?: number;
    llmConfirmedAt?: number;
    transcript?: string;
    // New fields for candidate/restart tracking
    candidateTimestamp?: number;
    candidateReason?: string;
    restartOccurred?: boolean;
    restartFromTimestamp?: number;
  };
}

/**
 * Audio frame analysis result
 */
export interface FrameAnalysis {
  // Frame timestamp in seconds
  timestamp: number;
  
  // RMS energy level (0-1)
  rmsEnergy: number;
  
  // Whether this frame is considered silence
  isSilence: boolean;
  
  // Beep detection result
  beepDetected: boolean;
  
  // Energy in the beep frequency band (0-1)
  beepBandEnergy?: number;
}

/**
 * State of the voicemail detection engine
 */
export interface DetectionState {
  // Current timestamp being processed
  currentTimestamp: number;
  
  // When silence started (null if not in silence)
  silenceStartTimestamp: number | null;
  
  // Accumulated transcript from STT
  transcript: string;
  
  // Whether LLM has confirmed greeting completion
  llmConfirmedGreetingEnd: boolean;
  
  // Timestamp of LLM confirmation
  llmConfirmationTimestamp: number | null;
  
  // Whether beep has been detected
  beepDetected: boolean;
  
  // Timestamp of beep detection
  beepTimestamp: number | null;
  
  // Whether detection has been finalized
  finalized: boolean;
  
  // Final detection result
  result: DetectionResult | null;
}

/**
 * WAV file header information
 */
export interface WavHeader {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * Deepgram transcript event
 */
export interface TranscriptEvent {
  transcript: string;
  isFinal: boolean;
  confidence: number;
  timestamp: number;
}

/**
 * LLM classification result
 */
export interface LLMClassificationResult {
  greetingComplete: boolean;
  rawResponse: string;
  timestamp: number;
}
