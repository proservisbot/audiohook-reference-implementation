# TCCP Integration Setup Guide

This guide explains how to start the TCCP (Transcription Call Control Protocol) solution that forwards Deepgram transcripts to an AudioCodes Bot API endpoint.

## Architecture Overview

```
┌─────────────┐     WebSocket      ┌─────────────────┐     HTTP POST     ┌──────────────────┐
│   Client    │ ─────────────────► │  AudioHook      │ ────────────────► │  AudioCodes Bot  │
│ (Microphone)│     Audio/PCMU     │  Server (TCCP)  │   Transcripts     │  API Endpoint    │
└─────────────┘                    └─────────────────┘                   └──────────────────┘
                                          │
                                          │ Audio
                                          ▼
                                   ┌─────────────┐
                                   │  Deepgram   │
                                   │  STT API    │
                                   └─────────────┘
```

## Prerequisites

1. **Node.js** (v18+)
2. **Deepgram API Key** - Get one from [Deepgram Console](https://console.deepgram.com/)
3. **AudioCodes Bot API credentials** (Bot URL, API Key, Event Webhook URL)

## Server Setup

### 1. Configure Environment Variables

Edit `app/.env`:

```bash
# Server Configuration
SERVERPORT=3000
SERVERHOST=127.0.0.1

# Transcription Service: 'deepgram', 'tccp', or 'both'
# Use 'both' to enable Deepgram transcription + TCCP forwarding
TRANSCRIPTION_SERVICE=both

# Deepgram Configuration
DEEPGRAM_API_KEY=your_deepgram_api_key
DEEPGRAM_MODEL=nova-2

# AudioCodes Bot API Configuration
AUDIOCODES_BOT_URL=https://your-audiocodes-endpoint/audiocodes/org/bot
AUDIOCODES_API_KEY=your_audiocodes_api_key
EVENT_WEBHOOK_URL=https://your-audiocodes-endpoint/callstatus/org/event

# Audio settings
AUDIO_SAMPLE_RATE=8000
AUDIO_CHANNELS=1
```

### 2. Install Dependencies

```bash
cd app
npm install
```

### 3. Start the Server

```bash
cd app
npm run dev
```

You should see output like:
```
[INFO] TCCP adapter initialized (AudioCodes HTTP format, no audio)
[INFO] Server listening on http://127.0.0.1:3000
```

## Client Setup

### 1. Install Dependencies

```bash
cd client
npm install
```

### 2. Start the Client with Microphone

```bash
cd client
npm start -- --microphone ws://localhost:3000/api/v1/tccp/ws
```

This will:
- Connect to the TCCP WebSocket endpoint
- Capture audio from your microphone
- Send audio to the server for transcription
- Forward transcripts to the AudioCodes Bot API

## Call Flow

When a call is initiated, the following sequence occurs:

1. **Bot Initialization** - POST to bot URL, receives `activitiesURL`, `disconnectURL`
2. **Start Activity** - POST start event to `activitiesURL`
3. **Initiated Event** - POST to event webhook with `CallStatus=initiated`
4. **In-Progress Event** - POST to event webhook with `CallStatus=in-progress`
5. **Transcripts** - POST transcript messages to `activitiesURL` as they arrive
6. **Disconnect** - POST to `disconnectURL` when call ends
7. **Completed Event** - POST to event webhook with `CallStatus=completed`

## Per-Call Logging

All HTTP requests/responses are logged to individual files in:
```
app/logs/tccp-calls/call-{conversationId}-{timestamp}.log
```

Each log file contains:
- Session metadata (IDs, URLs)
- All HTTP POST requests with full JSON bodies
- Response status codes and bodies
- Call duration and transcript count

## Testing with Mock Server

For local testing without a real AudioCodes endpoint:

### 1. Start the Mock Server

```bash
cd /path/to/audiohook-reference-implementation
python mock_audiocodes_server.py
```

### 2. Update Environment to Use Mock Server

Edit `app/.env`:
```bash
AUDIOCODES_BOT_URL=http://localhost:8095/audiocodes/sbcopilotstg/CI/bot
AUDIOCODES_API_KEY=test-api-key
EVENT_WEBHOOK_URL=http://localhost:8095/callstatus/sbcopilotstg/event
```

### 3. Start Server and Client

```bash
# Terminal 1: Start server
cd app && npm run dev

# Terminal 2: Start client
cd client && npm start -- --microphone ws://localhost:3000/api/v1/tccp/ws
```

## Troubleshooting

### No transcripts being sent
- Check that `TRANSCRIPTION_SERVICE=both` or `TRANSCRIPTION_SERVICE=tccp`
- Verify `DEEPGRAM_API_KEY` is valid
- Check server logs for Deepgram connection errors

### Connection refused to AudioCodes endpoint
- Verify `AUDIOCODES_BOT_URL` is correct
- Check network connectivity to the endpoint
- Review per-call logs in `app/logs/tccp-calls/`

### Signature mismatch errors
- Use the TCCP endpoint (`/api/v1/tccp/ws`) which doesn't require signature auth
- The audiohook endpoint (`/api/v1/audiohook/ws`) requires proper HMAC signatures

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVERPORT` | Yes | Server port (default: 3000) |
| `SERVERHOST` | Yes | Server host (default: 127.0.0.1) |
| `TRANSCRIPTION_SERVICE` | Yes | `deepgram`, `tccp`, or `both` |
| `DEEPGRAM_API_KEY` | Yes | Deepgram API key |
| `DEEPGRAM_MODEL` | No | Deepgram model (default: nova-2) |
| `AUDIOCODES_BOT_URL` | Yes* | AudioCodes bot endpoint URL |
| `AUDIOCODES_API_KEY` | Yes* | AudioCodes API key |
| `EVENT_WEBHOOK_URL` | No | Event webhook URL for call status |

*Required when `TRANSCRIPTION_SERVICE` is `tccp` or `both`
