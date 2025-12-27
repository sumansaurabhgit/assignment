/**
 * Configuration Module
 * 
 * Centralizes all configurable parameters for the voicemail detection system.
 * Values can be overridden via environment variables.
 */

import dotenv from 'dotenv';

dotenv.config();

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),

  // API Keys
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  openaiApiKey: process.env.OPENAI_API_KEY || '',

  // Audio Processing
  audio: {
    // Frame size for streaming simulation (ms)
    // 50ms provides good balance between latency and processing efficiency
    frameSizeMs: parseInt(process.env.FRAME_SIZE_MS || '50', 10),
    
    // Standard sample rate for telephony audio
    sampleRate: 16000,
  },

  // Beep Detection
  beep: {
    // Voicemail beeps vary widely: 800-2200 Hz range covers most systems
    // AT&T ~1000Hz, Verizon ~1400-1500Hz, Generic DTMF ~1000-2000Hz
    minFrequency: parseInt(process.env.BEEP_MIN_FREQ || '800', 10),
    maxFrequency: parseInt(process.env.BEEP_MAX_FREQ || '2200', 10),
    
    // Energy threshold: the ratio of energy in the beep frequency band
    // to total frame energy. Higher values = stricter detection
    energyThreshold: parseFloat(process.env.BEEP_ENERGY_THRESHOLD || '0.3'),
    
    // Minimum duration for a valid beep (ms)
    // Filters out transient spikes that might be speech harmonics
    minDurationMs: 50,
  },

  // Silence Detection
  silence: {
    // RMS threshold below which audio is considered silence
    // This value should account for typical background noise
    threshold: parseFloat(process.env.SILENCE_THRESHOLD || '0.01'),
    
    // Long silence duration for fallback trigger (ms)
    // If no speech/beep for this duration, assume greeting ended
    longDurationMs: parseInt(process.env.LONG_SILENCE_DURATION_MS || '1200', 10),
    
    // Short silence duration for LLM+silence combo (ms)
    // Used when LLM confirms greeting completion
    shortDurationMs: parseInt(process.env.SHORT_SILENCE_DURATION_MS || '400', 10),
  },

  // LLM Configuration
  llm: {
    model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
    
    // Minimum transcript length before querying LLM
    // Avoids unnecessary API calls for very short utterances
    minTranscriptLength: 20,
    
    // Cooldown between LLM queries (ms)
    // Prevents excessive API calls during continuous speech
    queryCooldownMs: 1000,
  },
};

/**
 * Validates that required API keys are present
 */
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.deepgramApiKey) {
    errors.push('DEEPGRAM_API_KEY is required');
  }

  if (!config.openaiApiKey) {
    errors.push('OPENAI_API_KEY is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
