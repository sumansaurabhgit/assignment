/**
 * Audio Utilities Module
 * 
 * Provides low-level audio signal processing functions:
 * - RMS (Root Mean Square) energy calculation for silence detection
 * - FFT-based frequency analysis for beep detection
 * - WAV file parsing for streaming simulation
 * 
 * DESIGN PHILOSOPHY:
 * These utilities are designed to work on small audio frames (20-100ms)
 * to enable real-time streaming analysis. The system processes audio
 * incrementally, just like a live phone call would be processed.
 */

import { config } from './config';
import { FrameAnalysis, WavHeader } from './types';

/**
 * Calculates the Root Mean Square (RMS) energy of an audio frame.
 * 
 * RMS is used for silence detection because it provides a single
 * value representing the "loudness" of the audio frame. Unlike
 * peak detection, RMS better represents perceived loudness and
 * is more robust against occasional spikes.
 * 
 * @param samples - Array of audio samples (normalized to -1 to 1)
 * @returns RMS value between 0 and 1
 */
export function calculateRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;

  let sumOfSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumOfSquares += samples[i] * samples[i];
  }

  return Math.sqrt(sumOfSquares / samples.length);
}

/**
 * Determines if an audio frame is silence based on RMS energy.
 * 
 * The threshold is configurable to accommodate different:
 * - Recording quality
 * - Background noise levels
 * - Microphone sensitivity
 * 
 * @param samples - Audio samples
 * @param threshold - RMS threshold (default from config)
 * @returns True if the frame is considered silence
 */
export function isSilence(
  samples: Float32Array,
  threshold: number = config.silence.threshold
): boolean {
  const rms = calculateRMS(samples);
  return rms < threshold;
}

/**
 * Simple FFT implementation (Cooley-Tukey radix-2 DIT)
 * 
 * Used for frequency analysis in beep detection. While not as
 * optimized as FFTW or similar libraries, this implementation
 * is sufficient for real-time analysis of small audio frames.
 * 
 * @param real - Real part of input (modified in place)
 * @param imag - Imaginary part of input (modified in place)
 */
function fft(real: Float32Array, imag: Float32Array): void {
  const n = real.length;
  
  // Bit-reversal permutation
  for (let i = 0, j = 0; i < n; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = n >> 1;
    while (k > 0 && j >= k) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Cooley-Tukey iterative FFT
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size / 2;
    const angleStep = -2 * Math.PI / size;

    for (let i = 0; i < n; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const angle = angleStep * j;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const evenIdx = i + j;
        const oddIdx = i + j + halfSize;

        const tReal = cos * real[oddIdx] - sin * imag[oddIdx];
        const tImag = sin * real[oddIdx] + cos * imag[oddIdx];

        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] = real[evenIdx] + tReal;
        imag[evenIdx] = imag[evenIdx] + tImag;
      }
    }
  }
}

/**
 * Pads or truncates array to the nearest power of 2 for FFT.
 */
function padToPowerOfTwo(samples: Float32Array): Float32Array {
  const n = samples.length;
  const nextPow2 = Math.pow(2, Math.ceil(Math.log2(n)));
  
  if (n === nextPow2) return samples;
  
  const padded = new Float32Array(nextPow2);
  padded.set(samples);
  return padded;
}

/**
 * Advanced Beep Detection with Tone Purity Analysis
 * 
 * PROBLEM WITH SIMPLE ENERGY RATIO:
 * Speech contains harmonics that can concentrate energy in the beep frequency range.
 * When someone says a number emphatically or speaks in a high pitch, the simple
 * energy ratio check can trigger false positives.
 * 
 * SOLUTION - MULTI-CRITERIA BEEP DETECTION:
 * Real voicemail beeps have these characteristics that speech does NOT:
 * 
 * 1. TONE PURITY (Spectral Flatness):
 *    - Beeps are pure single-frequency tones with very narrow bandwidth
 *    - Speech has energy spread across many frequencies (harmonics, formants)
 *    - We measure "spectral flatness" - beeps have LOW flatness (peaked), speech has HIGH
 * 
 * 2. PEAK PROMINENCE:
 *    - Beeps have ONE dominant peak that stands out significantly
 *    - Speech has multiple peaks of similar magnitude
 *    - We check if the peak is much higher than surrounding frequencies
 * 
 * 3. FREQUENCY STABILITY:
 *    - Beeps maintain the same frequency throughout
 *    - Speech frequencies vary rapidly (formant transitions)
 *    - This is tracked across frames in the decision engine
 * 
 * 4. ENERGY CONCENTRATION:
 *    - A true beep has >50-70% of its energy in a very narrow band (~50-100 Hz wide)
 *    - Speech might have 30% in the beep range but spread across the whole range
 * 
 * @param samples - Audio samples
 * @param sampleRate - Sample rate of the audio
 * @returns Detailed analysis for beep detection
 */
export interface BeepAnalysis {
  detected: boolean;
  confidence: number;          // 0-1, how confident we are this is a beep
  bandEnergy: number;          // Energy ratio in beep band
  totalEnergy: number;         // Total frame energy
  peakFrequency: number;       // Dominant frequency in Hz
  tonePurity: number;          // 0-1, how pure/narrow the tone is (1 = pure tone)
  peakProminence: number;      // How much the peak stands out
  isLikelySpeech: boolean;     // Heuristic: does this look like speech?
}

export function detectBeep(
  samples: Float32Array,
  sampleRate: number = config.audio.sampleRate
): { detected: boolean; bandEnergy: number; totalEnergy: number; analysis?: BeepAnalysis } {
  // Pad to power of 2 for FFT
  const paddedSamples = padToPowerOfTwo(samples);
  const n = paddedSamples.length;

  // Prepare arrays for FFT
  const real = new Float32Array(paddedSamples);
  const imag = new Float32Array(n);

  // Apply Hann window to reduce spectral leakage
  for (let i = 0; i < paddedSamples.length && i < samples.length; i++) {
    const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (samples.length - 1)));
    real[i] *= window;
  }

  // Perform FFT
  fft(real, imag);

  // Calculate magnitude spectrum (only positive frequencies)
  const magnitudes = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }

  // Calculate frequency resolution
  const freqResolution = sampleRate / n;

  // Find bin indices for beep frequency range
  const minBin = Math.floor(config.beep.minFrequency / freqResolution);
  const maxBin = Math.ceil(config.beep.maxFrequency / freqResolution);

  // =========================================================================
  // ANALYSIS 1: Find peak in beep frequency range
  // =========================================================================
  let peakMagnitude = 0;
  let peakBin = minBin;
  let beepBandEnergy = 0;
  
  for (let i = minBin; i <= maxBin && i < magnitudes.length; i++) {
    beepBandEnergy += magnitudes[i] * magnitudes[i];
    if (magnitudes[i] > peakMagnitude) {
      peakMagnitude = magnitudes[i];
      peakBin = i;
    }
  }
  
  const peakFrequency = peakBin * freqResolution;

  // Calculate total energy
  let totalEnergy = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    totalEnergy += magnitudes[i] * magnitudes[i];
  }

  // Avoid division by zero
  if (totalEnergy === 0 || peakMagnitude === 0) {
    return { detected: false, bandEnergy: 0, totalEnergy: 0 };
  }

  const bandEnergyRatio = beepBandEnergy / totalEnergy;

  // =========================================================================
  // ANALYSIS 2: Tone Purity - Check if energy is concentrated in narrow band
  // =========================================================================
  // For a pure tone, energy should be concentrated within ~50-100 Hz of peak
  // We check how much energy is within ±3 bins of the peak vs the whole beep band
  
  const narrowBandWidth = 3; // ±3 bins around peak
  let narrowBandEnergy = 0;
  for (let i = Math.max(0, peakBin - narrowBandWidth); 
       i <= Math.min(magnitudes.length - 1, peakBin + narrowBandWidth); i++) {
    narrowBandEnergy += magnitudes[i] * magnitudes[i];
  }
  
  // Tone purity: ratio of narrow band energy to beep band energy
  // Pure tone: ~0.8-1.0, Speech: ~0.2-0.5
  const tonePurity = beepBandEnergy > 0 ? narrowBandEnergy / beepBandEnergy : 0;

  // =========================================================================
  // ANALYSIS 3: Peak Prominence - How much does the peak stand out?
  // =========================================================================
  // Calculate average magnitude in the beep band (excluding peak area)
  let surroundingSum = 0;
  let surroundingCount = 0;
  for (let i = minBin; i <= maxBin && i < magnitudes.length; i++) {
    if (Math.abs(i - peakBin) > narrowBandWidth) {
      surroundingSum += magnitudes[i];
      surroundingCount++;
    }
  }
  const surroundingAvg = surroundingCount > 0 ? surroundingSum / surroundingCount : 0;
  
  // Peak prominence: how many times higher is the peak than surrounding?
  // Beep: typically 5-20x, Speech: typically 1-3x
  const peakProminence = surroundingAvg > 0 ? peakMagnitude / surroundingAvg : 0;

  // =========================================================================
  // ANALYSIS 4: Check if peak is actually IN the beep frequency range
  // =========================================================================
  // If the dominant peak is outside the beep band, this is likely speech
  // (speech harmonics at higher frequencies). A real beep has its peak
  // squarely within the expected beep frequency range.
  
  const peakInBeepBand = peakFrequency >= config.beep.minFrequency && 
                          peakFrequency <= config.beep.maxFrequency;

  // =========================================================================
  // FINAL DECISION: Combine all criteria
  // =========================================================================
  // 
  // STRICT BEEP CRITERIA (all must be true):
  // 1. Peak frequency is within beep band (1000-2000 Hz typically)
  // 2. Sufficient energy in beep band (>35% of total)
  // 3. High tone purity (>0.5) - pure tone, not spread out
  // 4. High peak prominence (>4x surrounding) - single dominant frequency
  // 5. Sufficient overall energy (not just noise)
  
  const BEEP_BAND_THRESHOLD = 0.35;     // At least 35% energy in beep band
  const TONE_PURITY_THRESHOLD = 0.5;    // At least 50% of beep band in narrow peak
  const PEAK_PROMINENCE_THRESHOLD = 4;  // Peak must be 4x higher than surroundings
  const NOISE_FLOOR = 0.0005;           // Minimum energy to consider
  
  const meetsEnergyRatio = bandEnergyRatio > BEEP_BAND_THRESHOLD;
  const meetsTonePurity = tonePurity > TONE_PURITY_THRESHOLD;
  const meetsPeakProminence = peakProminence > PEAK_PROMINENCE_THRESHOLD;
  const aboveNoiseFloor = totalEnergy > NOISE_FLOOR;
  
  const detected = peakInBeepBand &&
                   meetsEnergyRatio && 
                   meetsTonePurity && 
                   meetsPeakProminence && 
                   aboveNoiseFloor;
  
  // Calculate confidence score (0-1)
  let confidence = 0;
  if (aboveNoiseFloor && peakInBeepBand) {
    confidence = (
      (bandEnergyRatio / BEEP_BAND_THRESHOLD) * 0.3 +
      (tonePurity / TONE_PURITY_THRESHOLD) * 0.35 +
      (Math.min(peakProminence, 10) / 10) * 0.35
    );
    confidence = Math.min(1, confidence);
  }

  const analysis: BeepAnalysis = {
    detected,
    confidence,
    bandEnergy: bandEnergyRatio,
    totalEnergy,
    peakFrequency,
    tonePurity,
    peakProminence,
    isLikelySpeech: !peakInBeepBand, // Speech if peak is outside beep band
  };

  // Debug logging for tuning
  if (bandEnergyRatio > 0.2 || detected) { // Log when there's significant beep-band energy
    console.log(`[BeepDetect] freq=${peakFrequency.toFixed(0)}Hz, ` +
                `bandRatio=${bandEnergyRatio.toFixed(3)}, ` +
                `purity=${tonePurity.toFixed(3)}, ` +
                `prominence=${peakProminence.toFixed(1)}, ` +
                `inBand=${peakInBeepBand}, ` +
                `detected=${detected}`);
  }

  return {
    detected,
    bandEnergy: bandEnergyRatio,
    totalEnergy,
    analysis,
  };
}

/**
 * Parses a WAV file header to extract audio format information.
 * 
 * This is used to properly decode the audio data and calculate
 * frame boundaries for streaming simulation.
 * 
 * @param buffer - Buffer containing WAV file data
 * @returns Parsed header information
 */
export function parseWavHeader(buffer: Buffer): WavHeader {
  // Verify RIFF header
  const riff = buffer.toString('ascii', 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Invalid WAV file: missing RIFF header');
  }

  // Verify WAVE format
  const wave = buffer.toString('ascii', 8, 12);
  if (wave !== 'WAVE') {
    throw new Error('Invalid WAV file: missing WAVE format');
  }

  // Find fmt chunk
  let offset = 12;
  let fmtFound = false;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      // Parse format chunk
      // const audioFormat = buffer.readUInt16LE(offset + 8);
      numChannels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      // const byteRate = buffer.readUInt32LE(offset + 16);
      // const blockAlign = buffer.readUInt16LE(offset + 20);
      bitsPerSample = buffer.readUInt16LE(offset + 22);
      fmtFound = true;
    }

    if (chunkId === 'data') {
      if (!fmtFound) {
        throw new Error('Invalid WAV file: data chunk before fmt chunk');
      }

      return {
        sampleRate,
        numChannels,
        bitsPerSample,
        dataOffset: offset + 8,
        dataSize: chunkSize,
      };
    }

    offset += 8 + chunkSize;
  }

  throw new Error('Invalid WAV file: no data chunk found');
}

/**
 * Converts raw WAV data bytes to normalized Float32 samples.
 * 
 * @param buffer - Raw audio data bytes
 * @param bitsPerSample - Bits per sample (typically 16 or 24)
 * @param numChannels - Number of audio channels
 * @returns Normalized mono audio samples (-1 to 1)
 */
export function bytesToSamples(
  buffer: Buffer,
  bitsPerSample: number,
  numChannels: number
): Float32Array {
  const bytesPerSample = bitsPerSample / 8;
  const frameSize = bytesPerSample * numChannels;
  const numFrames = Math.floor(buffer.length / frameSize);
  const samples = new Float32Array(numFrames);

  for (let i = 0; i < numFrames; i++) {
    let sum = 0;

    // Average all channels to mono
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = i * frameSize + ch * bytesPerSample;

      let sample: number;
      if (bitsPerSample === 16) {
        sample = buffer.readInt16LE(offset) / 32768;
      } else if (bitsPerSample === 24) {
        // Read 24-bit sample
        const b0 = buffer[offset];
        const b1 = buffer[offset + 1];
        const b2 = buffer[offset + 2];
        const value = (b2 << 16) | (b1 << 8) | b0;
        sample = (value > 0x7FFFFF ? value - 0x1000000 : value) / 8388608;
      } else if (bitsPerSample === 8) {
        sample = (buffer[offset] - 128) / 128;
      } else {
        throw new Error(`Unsupported bits per sample: ${bitsPerSample}`);
      }

      sum += sample;
    }

    samples[i] = sum / numChannels;
  }

  return samples;
}

/**
 * Analyzes a single audio frame for silence and beep detection.
 * 
 * This is the main entry point for frame-by-frame audio analysis.
 * It combines RMS energy calculation with FFT-based beep detection.
 * 
 * @param samples - Audio samples for this frame
 * @param timestamp - Timestamp of the frame start (seconds)
 * @param sampleRate - Audio sample rate
 * @returns Analysis result for this frame
 */
export function analyzeFrame(
  samples: Float32Array,
  timestamp: number,
  sampleRate: number = config.audio.sampleRate
): FrameAnalysis {
  const rmsEnergy = calculateRMS(samples);
  const silenceDetected = rmsEnergy < config.silence.threshold;
  const beepResult = detectBeep(samples, sampleRate);

  return {
    timestamp,
    rmsEnergy,
    isSilence: silenceDetected,
    beepDetected: beepResult.detected,
    beepBandEnergy: beepResult.bandEnergy,
  };
}

/**
 * Creates an async generator that yields audio frames from a WAV buffer.
 * 
 * HOW STREAMING IS SIMULATED:
 * In a real telephony system, audio arrives in small chunks (typically 20ms)
 * from the network. To simulate this behavior with uploaded files, we:
 * 1. Parse the WAV header to understand the format
 * 2. Calculate frame size based on sample rate and desired frame duration
 * 3. Yield one frame at a time, as if it just arrived from the network
 * 
 * This allows us to test and validate the streaming detection logic
 * without needing an actual phone call.
 * 
 * @param buffer - Complete WAV file buffer
 * @param frameDurationMs - Duration of each frame in milliseconds
 * @yields Audio frames with their timestamps
 */
export async function* streamAudioFrames(
  buffer: Buffer,
  frameDurationMs: number = config.audio.frameSizeMs
): AsyncGenerator<{ samples: Float32Array; timestamp: number; sampleRate: number }> {
  // Parse WAV header
  const header = parseWavHeader(buffer);
  
  // Calculate samples per frame
  const samplesPerFrame = Math.floor(
    (header.sampleRate * frameDurationMs) / 1000
  );
  
  // Calculate bytes per frame
  const bytesPerSample = header.bitsPerSample / 8;
  const bytesPerFrame = samplesPerFrame * bytesPerSample * header.numChannels;
  
  // Get audio data section
  const audioData = buffer.subarray(
    header.dataOffset,
    header.dataOffset + header.dataSize
  );

  let frameIndex = 0;
  let offset = 0;

  while (offset + bytesPerFrame <= audioData.length) {
    // Extract frame bytes
    const frameBytes = audioData.subarray(offset, offset + bytesPerFrame);
    
    // Convert to samples
    const samples = bytesToSamples(
      Buffer.from(frameBytes),
      header.bitsPerSample,
      header.numChannels
    );

    // Calculate timestamp
    const timestamp = (frameIndex * frameDurationMs) / 1000;

    yield {
      samples,
      timestamp,
      sampleRate: header.sampleRate,
    };

    offset += bytesPerFrame;
    frameIndex++;
  }
}
