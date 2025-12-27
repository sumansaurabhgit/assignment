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
 * Detects if a beep is present in the audio frame using FFT analysis.
 * 
 * BEEP DETECTION STRATEGY:
 * Voicemail beeps are typically single-frequency tones in the 1000-1400 Hz range.
 * They have these characteristics:
 * 1. High energy concentration in a narrow frequency band
 * 2. Sustained for at least 50-200ms
 * 3. Significantly louder than background noise
 * 
 * This function analyzes the frequency spectrum and checks if there's
 * a strong energy spike in the expected beep frequency range.
 * 
 * WHY BEEP DETECTION HAS HIGHEST PRIORITY:
 * A beep is an unambiguous signal that the voicemail system is ready
 * for recording. Unlike speech analysis which can be uncertain, a beep
 * is a definitive marker. If we start too early (during silence before
 * the beep), the consumer won't hear the required compliance message.
 * 
 * @param samples - Audio samples
 * @param sampleRate - Sample rate of the audio
 * @returns Object with detection result and band energy
 */
export function detectBeep(
  samples: Float32Array,
  sampleRate: number = config.audio.sampleRate
): { detected: boolean; bandEnergy: number; totalEnergy: number } {
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

  // Calculate magnitude spectrum
  const magnitudes = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    magnitudes[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }

  // Calculate frequency resolution
  const freqResolution = sampleRate / n;

  // Find bin indices for beep frequency range
  const minBin = Math.floor(config.beep.minFrequency / freqResolution);
  const maxBin = Math.ceil(config.beep.maxFrequency / freqResolution);

  // Calculate energy in beep band
  let beepBandEnergy = 0;
  let peakMagnitude = 0;
  for (let i = minBin; i <= maxBin && i < magnitudes.length; i++) {
    beepBandEnergy += magnitudes[i] * magnitudes[i];
    peakMagnitude = Math.max(peakMagnitude, magnitudes[i]);
  }

  // Calculate total energy
  let totalEnergy = 0;
  for (let i = 0; i < magnitudes.length; i++) {
    totalEnergy += magnitudes[i] * magnitudes[i];
  }

  // Avoid division by zero
  if (totalEnergy === 0) {
    return { detected: false, bandEnergy: 0, totalEnergy: 0 };
  }

  // Calculate energy ratio
  const energyRatio = beepBandEnergy / totalEnergy;

  // Detection criteria:
  // 1. Energy ratio in beep band exceeds threshold
  // 2. Total energy is above noise floor (not just noise concentrated in one band)
  const noiseFloor = 0.001; // Minimum energy to consider
  const detected = 
    energyRatio > config.beep.energyThreshold && 
    totalEnergy > noiseFloor;

  return {
    detected,
    bandEnergy: energyRatio,
    totalEnergy,
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
