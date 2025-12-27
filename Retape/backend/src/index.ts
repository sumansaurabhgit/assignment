/**
 * Express Server - Main Entry Point
 * 
 * Provides REST API endpoints for the voicemail detection system:
 * - POST /api/analyze - Upload and analyze a WAV file
 * - GET /api/health - Health check endpoint
 * 
 * The server handles file uploads using multer and processes
 * them through the streaming detection pipeline.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import { config, validateConfig } from './config';
import { processAudioFile, validateWavFile, ProcessingProgress } from './audioService';
import { DetectionResult, FrameAnalysis, TranscriptEvent } from './types';

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
// Using memory storage since we process files in streaming fashion
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept WAV files only
    if (file.mimetype === 'audio/wav' || 
        file.mimetype === 'audio/wave' ||
        file.originalname.endsWith('.wav')) {
      cb(null, true);
    } else {
      cb(new Error('Only WAV files are accepted'));
    }
  },
});

/**
 * Health check endpoint
 */
app.get('/api/health', (req: Request, res: Response) => {
  const configValidation = validateConfig();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      hasDeepgramKey: !!config.deepgramApiKey,
      hasOpenAIKey: !!config.openaiApiKey,
      frameSizeMs: config.audio.frameSizeMs,
      valid: configValidation.valid,
      errors: configValidation.errors,
    },
  });
});

/**
 * Main analysis endpoint
 * 
 * Accepts a WAV file upload and processes it through the
 * voicemail detection pipeline in streaming fashion.
 * 
 * Request:
 * - Method: POST
 * - Content-Type: multipart/form-data
 * - Body: audio file (field name: 'audio')
 * - Optional query param: useMock=true (use mock services)
 * 
 * Response:
 * {
 *   success: boolean,
 *   result: DetectionResult,
 *   processingTime: number,
 *   streamingEvents: {
 *     candidateStarted: boolean,      // Was a candidate start triggered?
 *     candidateTimestamp?: number,    // When candidate started
 *     restartOccurred: boolean,       // Did beep override candidate?
 *     restartTimestamp?: number,      // When restart was triggered
 *   },
 *   debug?: { ... }
 * }
 */
app.post('/api/analyze', upload.single('audio'), async (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  try {
    // Check if file was uploaded
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No audio file provided',
      });
      return;
    }

    console.log(`[API] Received file: ${req.file.originalname} (${req.file.size} bytes)`);

    // Validate WAV file format
    const validation = validateWavFile(req.file.buffer);
    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: validation.error,
      });
      return;
    }

    // Check if mock mode is requested
    const useMock = req.query.useMock === 'true' || !validateConfig().valid;
    
    if (useMock) {
      console.log('[API] Using mock services (API keys not configured or mock mode requested)');
    }

    // Collect debug information during processing
    const debugInfo: {
      frames: FrameAnalysis[];
      transcripts: TranscriptEvent[];
      processingProgress: ProcessingProgress[];
    } = {
      frames: [],
      transcripts: [],
      processingProgress: [],
    };

    // Track streaming events
    const streamingEvents: {
      candidateStarted: boolean;
      candidateTimestamp?: number;
      candidateReason?: string;
      restartOccurred: boolean;
      restartTimestamp?: number;
      restartPreviousTimestamp?: number;
    } = {
      candidateStarted: false,
      restartOccurred: false,
    };

    // Process the audio file
    const result = await processAudioFile(req.file.buffer, {
      useMock,
      simulateRealTime: false, // Don't delay for API requests
      onProgress: (progress) => {
        debugInfo.processingProgress.push(progress);
      },
      onFrame: (frame) => {
        // Only keep frames with significant events
        if (frame.beepDetected || !frame.isSilence) {
          debugInfo.frames.push(frame);
        }
      },
      onTranscript: (event) => {
        debugInfo.transcripts.push(event);
      },
      // Track candidate start events
      onCandidateStart: (event) => {
        streamingEvents.candidateStarted = true;
        streamingEvents.candidateTimestamp = event.timestamp;
        streamingEvents.candidateReason = event.reason;
      },
      // Track restart events (beep after candidate)
      onRestart: (event) => {
        streamingEvents.restartOccurred = true;
        streamingEvents.restartTimestamp = event.timestamp;
        streamingEvents.restartPreviousTimestamp = event.previousTimestamp;
      },
    });

    const processingTime = Date.now() - startTime;

    console.log(`[API] Analysis complete in ${processingTime}ms`);
    console.log(`[API] Result: ${result.detected ? result.reason : 'no detection'} at ${result.timestamp.toFixed(3)}s`);
    
    if (streamingEvents.restartOccurred) {
      console.log(`[API] ⚠️  RESTART occurred: beep at ${streamingEvents.restartTimestamp}s overrode candidate at ${streamingEvents.restartPreviousTimestamp}s`);
    }

    res.json({
      success: true,
      result,
      processingTime,
      streamingEvents,
      debug: {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        usedMockServices: useMock,
        framesAnalyzed: debugInfo.processingProgress.length,
        significantFrames: debugInfo.frames.length,
        transcriptEvents: debugInfo.transcripts.length,
        finalTranscript: debugInfo.transcripts.length > 0 
          ? debugInfo.transcripts[debugInfo.transcripts.length - 1].transcript 
          : '',
      },
    });
  } catch (error) {
    console.error('[API] Error processing audio:', error);
    next(error);
  }
});

/**
 * Error handling middleware
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[API] Error:', err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 50MB.',
      });
      return;
    }
  }

  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

/**
 * Start the server
 */
const PORT = config.port;

app.listen(PORT, () => {
  console.log('='.repeat(50));
  console.log('Voicemail Detection Server');
  console.log('='.repeat(50));
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`Analysis endpoint: POST http://localhost:${PORT}/api/analyze`);
  console.log('');
  
  const configValidation = validateConfig();
  if (!configValidation.valid) {
    console.log('⚠️  Configuration warnings:');
    configValidation.errors.forEach(err => console.log(`   - ${err}`));
    console.log('   Mock services will be used for missing API keys.');
  } else {
    console.log('✅ All API keys configured');
  }
  
  console.log('='.repeat(50));
});

export default app;
