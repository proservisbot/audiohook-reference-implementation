# TCCP Integration with Deepgram Transcription

This extension adds real-time transcription capabilities to the AudioHook reference implementation using Deepgram as the downstream transcription service.

## Overview

The TCCP (Transcription Cloud Connector Protocol) integration routes audio from AudioHook sessions to Deepgram for real-time speech-to-text transcription. It supports:

- **Real-time streaming transcription** via Deepgram's WebSocket API
- **PCMU (μ-law) audio format** at 8kHz sample rate
- **Microphone input** for testing via the enhanced client
- **Session lifecycle management** with pause/resume support

## Architecture

```
┌─────────────────┐     AudioHook      ┌─────────────────┐     Deepgram     ┌─────────────────┐
│  Microphone     │ ──── WebSocket ──▶ │  TCCP Endpoint  │ ──── WebSocket ─▶│  Deepgram API   │
│  Client         │     (PCMU audio)   │  /api/v1/tccp   │     (mulaw)      │  (nova-2)       │
└─────────────────┘                    └─────────────────┘                  └─────────────────┘
                                              │
                                              ▼
                                       Transcript Events
                                       (logged to console)
```

## Quick Start

### Prerequisites

- Node.js 18+
- Deepgram API key (get one at https://console.deepgram.com)
- macOS with microphone access (for client testing)

### 1. Install Dependencies

```bash
# Server
cd app
npm install

# Client
cd ../client
npm install
```

### 2. Configure Environment

Create `app/.env`:

```bash
# Deepgram Configuration
TRANSCRIPTION_SERVICE=deepgram
DEEPGRAM_API_KEY=your-deepgram-api-key-here
DEEPGRAM_MODEL=nova-2

# Server Configuration
SERVERPORT=3000
SERVERHOST=127.0.0.1

# Audio Settings
AUDIO_SAMPLE_RATE=8000
AUDIO_CHANNELS=1

# Development
NODE_ENV=development
```

### 3. Start the Server

```bash
cd app
npm start
```

You should see:
```
[INFO] Deepgram adapter initialized (model: nova-2)
[INFO] TCCP downstream service initialized (service: deepgram)
[INFO] Server listening at http://127.0.0.1:3000
[INFO] Routes:
└── /api/v1/tccp/ws (GET, HEAD)
```

### 4. Run the Microphone Client

In a separate terminal:

```bash
cd client
npm start -- --microphone ws://localhost:3000/api/v1/tccp/ws
```

Speak into your microphone. You'll see transcripts in the server logs:

```
[INFO] Final transcript
    transcript: "This is a test of Deepgram, see if the integration is working."
    confidence: 1
```

## Client Options

```bash
npm start -- [options] <server-uri>

Options:
  --microphone              Use microphone as audio source
  --wavfile <file>          Use WAV file as audio source
  --max-stream-duration <s> Limit stream duration (seconds)
  --api-key <key>           API key for authentication
  --session-log-level <lvl> Log level (debug, info, warn, error)
```

### Examples

```bash
# Microphone input with 30 second limit
npm start -- --microphone --max-stream-duration 30 ws://localhost:3000/api/v1/tccp/ws

# WAV file input
npm start -- --wavfile ./test.wav ws://localhost:3000/api/v1/tccp/ws
```

## Project Structure

```
app/src/tccp-integration/
├── audiohook-tccp-endpoint.ts   # Main WebSocket endpoint
├── deepgram-adapter.ts          # Deepgram SDK integration
├── downstream.ts                # Service interfaces & types
├── factory.ts                   # Service factory
└── session.ts                   # Session record types

client/src/
├── mediasource-mic.ts           # Microphone audio source
├── mediasource-tone.ts          # Test tone source
├── mediasource-wav.ts           # WAV file source
└── index.ts                     # CLI entry point
```

## Key Files

### Server Endpoint
`app/src/tccp-integration/audiohook-tccp-endpoint.ts`

Handles AudioHook WebSocket connections, routes audio to Deepgram, and manages session lifecycle.

### Deepgram Adapter
`app/src/tccp-integration/deepgram-adapter.ts`

Implements the `DownstreamService` interface for Deepgram's live transcription API.

### Microphone Source
`client/src/mediasource-mic.ts`

Captures microphone audio, converts L16 PCM to PCMU (μ-law), and streams via AudioHook protocol.

## Configuration Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `TRANSCRIPTION_SERVICE` | Service type (`deepgram` or `tccp`) | `deepgram` |
| `DEEPGRAM_API_KEY` | Deepgram API key | Required |
| `DEEPGRAM_MODEL` | Deepgram model | `nova-2` |
| `AUDIO_SAMPLE_RATE` | Audio sample rate | `8000` |
| `AUDIO_CHANNELS` | Audio channels | `1` |
| `SERVERPORT` | Server port | `3000` |
| `NODE_ENV` | Environment (`development` skips auth) | - |

## Development Notes

### Authentication

In development mode (`NODE_ENV !== 'production'`), HTTP signature authentication is skipped. For production, configure proper signature verification.

### Audio Format

- **Client → Server**: PCMU (μ-law), 8kHz, mono
- **Server → Deepgram**: mulaw encoding, 8kHz

### Deepgram Events

The adapter listens for:
- `LiveTranscriptionEvents.Open` - Connection established
- `LiveTranscriptionEvents.Transcript` - Transcription result
- `LiveTranscriptionEvents.Error` - Error occurred
- `LiveTranscriptionEvents.Close` - Connection closed

## Troubleshooting

### No transcripts appearing

1. Check Deepgram API key is valid
2. Verify microphone permissions
3. Check server logs for `Deepgram transcription connection opened`
4. Ensure audio chunks are being received (`Audio chunks received` logs)

### Connection rejected (unauthorized)

Set `NODE_ENV=development` or configure proper HTTP signature authentication.

### No audio data

1. Check microphone is working: `rec -c 1 -r 8000 test.wav`
2. Verify `node-record-lpcm16` is installed in client
3. Check for `[MediaSource] First audio data received` log

## Branch

All TCCP changes are on branch: `feature/tccp-integration`
