/**
 * Test Audio Generator
 * 
 * Utility script to generate test WAV files for voicemail detection testing.
 * Creates synthetic audio with speech patterns, silence, and beeps.
 * 
 * Usage: npx ts-node scripts/generateTestAudio.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// WAV file parameters
const SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;

/**
 * Generates a sine wave tone
 */
function generateTone(
  frequency: number,
  durationMs: number,
  amplitude: number = 0.5
): Int16Array {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const samples = new Int16Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    const value = Math.sin(2 * Math.PI * frequency * t) * amplitude;
    samples[i] = Math.floor(value * 32767);
  }
  
  return samples;
}

/**
 * Generates silence (or very low noise)
 */
function generateSilence(durationMs: number, noiseLevel: number = 0.001): Int16Array {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const samples = new Int16Array(numSamples);
  
  for (let i = 0; i < numSamples; i++) {
    samples[i] = Math.floor((Math.random() * 2 - 1) * noiseLevel * 32767);
  }
  
  return samples;
}

/**
 * Generates simulated speech (multiple frequency components)
 */
function generateSpeechLike(durationMs: number, amplitude: number = 0.3): Int16Array {
  const numSamples = Math.floor((SAMPLE_RATE * durationMs) / 1000);
  const samples = new Int16Array(numSamples);
  
  // Simulate speech with fundamental frequency + harmonics
  const fundamentalFreq = 150 + Math.random() * 100; // 150-250 Hz
  
  for (let i = 0; i < numSamples; i++) {
    const t = i / SAMPLE_RATE;
    
    // Add multiple harmonics for speech-like sound
    let value = 0;
    value += Math.sin(2 * Math.PI * fundamentalFreq * t) * 0.5;
    value += Math.sin(2 * Math.PI * fundamentalFreq * 2 * t) * 0.3;
    value += Math.sin(2 * Math.PI * fundamentalFreq * 3 * t) * 0.15;
    value += Math.sin(2 * Math.PI * fundamentalFreq * 4 * t) * 0.05;
    
    // Add some modulation for natural variation
    const envelope = 0.8 + 0.2 * Math.sin(2 * Math.PI * 3 * t);
    value *= envelope * amplitude;
    
    samples[i] = Math.floor(value * 32767);
  }
  
  return samples;
}

/**
 * Generates a voicemail beep (1200 Hz tone)
 */
function generateBeep(durationMs: number = 200): Int16Array {
  return generateTone(1200, durationMs, 0.7);
}

/**
 * Concatenates multiple Int16Arrays
 */
function concatenate(...arrays: Int16Array[]): Int16Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Int16Array(totalLength);
  
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  
  return result;
}

/**
 * Creates a WAV file buffer from samples
 */
function createWavBuffer(samples: Int16Array): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 44 + dataSize; // 44 bytes for header

  const buffer = Buffer.alloc(fileSize);
  
  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write('WAVE', 8);
  
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format (PCM)
  buffer.writeUInt16LE(NUM_CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(NUM_CHANNELS * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  
  // Write samples
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * bytesPerSample);
  }
  
  return buffer;
}

/**
 * Test case: Greeting followed by beep
 * Expected: Detection at beep timestamp
 */
function createTestWithBeep(): Buffer {
  const samples = concatenate(
    generateSpeechLike(2000),      // 2s of "speech"
    generateSilence(300),          // 0.3s pause
    generateSpeechLike(1500),      // 1.5s more speech
    generateSilence(500),          // 0.5s pause
    generateBeep(200),             // Beep!
    generateSilence(1000)          // 1s silence after beep
  );
  
  return createWavBuffer(samples);
}

/**
 * Test case: Greeting followed by long silence (no beep)
 * Expected: Detection via silence fallback
 */
function createTestWithLongSilence(): Buffer {
  const samples = concatenate(
    generateSpeechLike(2000),      // 2s of "speech"
    generateSilence(300),          // 0.3s pause
    generateSpeechLike(1500),      // 1.5s more speech
    generateSilence(2000),         // 2s of silence (triggers fallback)
    generateSilence(500)           // More silence
  );
  
  return createWavBuffer(samples);
}

/**
 * Test case: Silence followed by late beep (edge case)
 * Expected: Detection at beep, NOT during silence
 */
function createTestSilenceThenBeep(): Buffer {
  const samples = concatenate(
    generateSpeechLike(2000),      // 2s of "speech"
    generateSilence(2500),         // 2.5s of silence (would trigger fallback)
    generateBeep(200),             // Late beep!
    generateSilence(1000)          // 1s silence after beep
  );
  
  return createWavBuffer(samples);
}

/**
 * Test case: Just a beep (immediate)
 */
function createTestImmediateBeep(): Buffer {
  const samples = concatenate(
    generateSilence(200),          // Brief silence
    generateBeep(200),             // Immediate beep
    generateSilence(1000)          // Silence after
  );
  
  return createWavBuffer(samples);
}

// Main execution
const testDir = path.join(__dirname, '..', 'test-audio');

if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

console.log('Generating test audio files...\n');

const testFiles = [
  { name: 'greeting-with-beep.wav', generator: createTestWithBeep, description: 'Speech -> pause -> beep' },
  { name: 'greeting-long-silence.wav', generator: createTestWithLongSilence, description: 'Speech -> long silence (no beep)' },
  { name: 'silence-then-beep.wav', generator: createTestSilenceThenBeep, description: 'Speech -> silence -> late beep (edge case)' },
  { name: 'immediate-beep.wav', generator: createTestImmediateBeep, description: 'Immediate beep' },
];

for (const { name, generator, description } of testFiles) {
  const buffer = generator();
  const filePath = path.join(testDir, name);
  fs.writeFileSync(filePath, buffer);
  
  const durationSeconds = (buffer.length - 44) / (SAMPLE_RATE * 2);
  console.log(`✓ ${name}`);
  console.log(`  Description: ${description}`);
  console.log(`  Duration: ${durationSeconds.toFixed(2)}s`);
  console.log(`  Size: ${(buffer.length / 1024).toFixed(1)} KB\n`);
}

console.log(`Test files saved to: ${testDir}`);
