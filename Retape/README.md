# Voicemail Detection System

A streaming voicemail detection system that determines the optimal timestamp to start playing a compliant pre-recorded voicemail message after a consumer's voicemail greeting ends.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  File Upload UI → Display Results → Debug Information   │    │
│  └─────────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────────┘
                             │ POST /api/analyze
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backend (Node.js + TypeScript)                │
│                                                                  │
│  ┌──────────────┐     ┌──────────────────────────────────────┐  │
│  │ Audio Upload │────▶│         Audio Service                 │  │
│  │   Endpoint   │     │  (Orchestrates streaming processing)  │  │
│  └──────────────┘     └────────────────┬─────────────────────┘  │
│                                        │                         │
│                    ┌───────────────────┼───────────────────┐    │
│                    ▼                   ▼                   ▼    │
│         ┌─────────────────┐  ┌─────────────────┐  ┌───────────┐│
│         │  Audio Utils    │  │   Deepgram      │  │  OpenAI   ││
│         │  - RMS Energy   │  │   Handler       │  │  LLM      ││
│         │  - FFT/Beep     │  │   (STT Stream)  │  │ Classifier││
│         │  - WAV Parser   │  │                 │  │           ││
│         └────────┬────────┘  └────────┬────────┘  └─────┬─────┘│
│                  │                    │                  │      │
│                  └────────────────────┼──────────────────┘      │
│                                       ▼                         │
│                    ┌──────────────────────────────────┐         │
│                    │     Decision Engine              │         │
│                    │  - Beep detection (highest)      │         │
│                    │  - LLM + silence                 │         │
│                    │  - Silence fallback              │         │
│                    └──────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
Retape/
├── backend/
│   ├── src/
│   │   ├── index.ts           # Express server & API endpoints
│   │   ├── config.ts          # Configuration management
│   │   ├── types.ts           # TypeScript type definitions
│   │   ├── audioUtils.ts      # RMS, FFT, beep detection, WAV parsing
│   │   ├── deepgramHandler.ts # Streaming STT handler
│   │   ├── llmClassifier.ts   # OpenAI greeting classifier
│   │   ├── decisionEngine.ts  # Core decision logic
│   │   └── audioService.ts    # Audio processing orchestration
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
│
└── frontend/
    ├── public/
    │   └── index.html
    ├── src/
    │   ├── index.js
    │   ├── index.css
    │   └── App.js
    └── package.json
```

## Setup Instructions

### Prerequisites

- Node.js 18+ 
- npm or yarn
- (Optional) Deepgram API key for speech-to-text
- (Optional) OpenAI API key for LLM classification

### Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy environment file and add your API keys
cp .env.example .env

# Edit .env with your API keys (optional - mock mode works without them)
# DEEPGRAM_API_KEY=your_key_here
# OPENAI_API_KEY=your_key_here

# Start development server
npm run dev
```

The backend will start on `http://localhost:3001`

### Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm start
```

The frontend will start on `http://localhost:3000`

## Usage

1. Open `http://localhost:3000` in your browser
2. Upload a WAV audio file (drag & drop or click to browse)
3. Optionally check "Use mock services" if you don't have API keys
4. Click "Analyze Audio"
5. View the detection results including timestamp and reason

## Detection Logic

### Signal Priority Hierarchy (Strictly Enforced)

| Priority | Signal | Type | Description |
|----------|--------|------|-------------|
| 1 (Highest) | **Beep Detection** | FINAL | Always overrides all other signals. Uses FFT frequency analysis (1000-1400 Hz). |
| 2 | **LLM + Silence** | CANDIDATE | LLM confirms greeting complete + short silence (300-500ms). Can be overridden by beep. |
| 3 (Lowest) | **Silence Fallback** | CANDIDATE | Extended silence (1200ms+). Can be overridden by beep. |

### Candidate vs Final Decisions

**CANDIDATE DECISION:**
- Produced by silence or LLM+silence signals
- Triggers voicemail streaming to BEGIN
- Can be OVERRIDDEN if a beep is detected later
- Consumer may NOT actually hear content played during this time

**FINAL DECISION:**
- Produced ONLY by beep detection OR end of audio stream
- If beep: voicemail MUST restart from beep timestamp
- If end of stream with no beep: candidate becomes final

### Critical Compliance Rule

If a voicemail beep occurs, the consumer CANNOT hear anything spoken before the beep. The beep boundary defines what the consumer actually hears.

**Therefore:**
- Voicemail playback that begins during silence is NOT audible if a beep occurs later
- When beep is detected after a candidate start, the system:
  1. Emits `restart` event to signal the caller
  2. Discards the earlier silence/LLM start
  3. Uses beep timestamp as the FINAL authoritative start

### Critical Edge Case: Silence then Beep

**Scenario:** Greeting ends → several seconds of silence → THEN beep occurs

**Timeline:**
```
0.0s - Greeting starts
3.0s - Greeting ends
3.5s - Silence detected, CANDIDATE start triggered → emit 'candidate_start'
3.5s - Caller begins streaming voicemail
5.0s - BEEP DETECTED → emit 'restart' with beep timestamp
5.0s - Caller MUST restart voicemail streaming from beginning
5.0s - FINAL decision locked at beep timestamp
```

### Events Emitted by Decision Engine

| Event | Description | When to Act |
|-------|-------------|-------------|
| `candidate_start` | Silence/LLM triggered candidate start | Begin streaming voicemail (but be ready to restart) |
| `restart` | Beep detected after candidate | STOP and RESTART voicemail from beginning |
| `final_decision` | Decision is final | Commit to the timestamp |

## API Endpoints

### POST /api/analyze

Upload and analyze a WAV file.

**Request:**
- Content-Type: `multipart/form-data`
- Body: `audio` field with WAV file
- Query params: `useMock=true` (optional, use mock services)

**Response:**
```json
{
  "success": true,
  "result": {
    "detected": true,
    "timestamp": 5.432,
    "reason": "beep",
    "explanation": "Voicemail beep detected - this is the authoritative start time",
    "debug": {
      "beepDetectedAt": 5.432,
      "transcript": "Hi, you've reached John..."
    }
  },
  "streamingEvents": {
    "candidateStarted": true,
    "candidateTimestamp": 3.5,
    "candidateReason": "silence_fallback",
    "restartOccurred": true,
    "restartTimestamp": 5.432,
    "restartPreviousTimestamp": 3.5
  },
  "processingTime": 1234,
  "debug": {
    "fileName": "voicemail.wav",
    "fileSize": 123456,
    "usedMockServices": false
  }
}
```

### GET /api/health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "config": {
    "hasDeepgramKey": true,
    "hasOpenAIKey": true,
    "frameSizeMs": 50
  }
}
```

## Configuration

Environment variables in `.env`:

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 3001 |
| DEEPGRAM_API_KEY | Deepgram API key | - |
| OPENAI_API_KEY | OpenAI API key | - |
| FRAME_SIZE_MS | Audio frame size (ms) | 50 |
| BEEP_MIN_FREQ | Min beep frequency (Hz) | 1000 |
| BEEP_MAX_FREQ | Max beep frequency (Hz) | 1400 |
| BEEP_ENERGY_THRESHOLD | Beep detection threshold | 0.3 |
| SILENCE_THRESHOLD | RMS silence threshold | 0.01 |
| LONG_SILENCE_DURATION_MS | Fallback silence (ms) | 1200 |
| SHORT_SILENCE_DURATION_MS | LLM+silence threshold (ms) | 400 |

## Key Design Decisions

### Why Beep Overrides Everything

A beep is the voicemail system's explicit signal that recording has started. Unlike speech patterns (which require interpretation) or silence (which could be a pause), a beep is unambiguous. If we start the compliance message before the beep, the consumer won't hear it because the beep typically marks the actual recording start.

### How Streaming is Simulated

In production, audio arrives in real-time from a phone call. For uploaded files, we simulate this by:

1. Parsing the WAV header to understand the format
2. Calculating frame size (e.g., 50ms of audio)
3. Processing one frame at a time, sequentially
4. Making decisions based only on frames seen so far (no look-ahead)

This ensures the algorithm would work correctly with live audio.

### How LLM Decisions Combine with Audio Signals

The LLM performs **semantic analysis only**, not timing decisions:
- Input: Partial transcript text
- Output: "YES" (greeting complete) or "NO" (still in progress)

The decision engine then combines:
- LLM semantic judgment (is the greeting complete?)
- Audio signal (is there silence confirming the end?)
- Override logic (has a beep occurred?)

This separation ensures robust, explainable decisions.

## Testing Without API Keys

The system includes mock implementations for testing:

- **MockDeepgramHandler**: Simulates progressive transcript generation
- **MockLLMClassifier**: Uses heuristic phrase matching

Enable mock mode by:
1. Not setting API keys in `.env`
2. Checking "Use mock services" in the UI
3. Adding `?useMock=true` to API requests

## Compliance Note

This system is designed for compliance with regulations requiring that voicemail messages include company name and callback number. The detection ensures that anything spoken AFTER the beep (when recording actually starts) will be heard by the consumer.
