# Dual-Stream SIPREC Call Simulation

This document describes the dual-stream SIPREC call simulation approach for testing the AudioHook integration with AudioCodes Bot API, using pre-recorded audio files instead of live microphones.

## Overview

Traditional AudioHook testing uses a single audio stream from a microphone. This dual-stream approach simulates a real person-to-person call by creating **two simultaneous AudioHook sessions** that share the same conversation ID:

- **Customer leg** (caller/inbound): Plays customer audio file
- **Agent leg** (outbound): Plays agent audio file

Both legs are connected to the same conversation manager, which forwards transcripts from each leg to AudioCodes with appropriate participant tagging.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AudioHook Client                          │
│  ┌─────────────────┐         ┌─────────────────┐           │
│  │ Customer Leg    │         │ Agent Leg       │           │
│  │ - WAV file      │         │ - WAV file      │           │
│  │ - participant-1 │         │ - participant-2 │           │
│  └────────┬────────┘         └────────┬────────┘           │
│           │                          │                      │
│           └──────────┬───────────────┘                      │
│                      │                                       │
│           Same conversationId (UUID)                        │
└──────────────────────┼───────────────────────────────────────┘
                       │
              WebSocket Connection
                       │
┌──────────────────────┼───────────────────────────────────────┐
│                      ▼                                       │
│              AudioHook Server                                │
│         /api/v1/tccp/ws endpoint                             │
│                      │                                       │
│         ┌────────────┴────────────┐                          │
│         │   ConversationManager   │                          │
│         │   - caller (inbound)    │                          │
│         │   - agent (outbound)    │                          │
│         └────────────┬────────────┘                          │
│                    │                                         │
│         ┌──────────┴──────────┐                           │
│         │   TCCP Adapter        │                           │
│         │   Maps legs to:       │                           │
│         │   - inbound (caller)  │                           │
│         │   - outbound (agent)  │                           │
│         └──────────┬────────────┘                           │
└──────────────────┼──────────────────────────────────────────┘
                   │
         ┌─────────┴──────────┐
         │   AudioCodes Bot   │
         │   participant      │ ←── customer/caller audio
         │   participant-2    │ ←── agent audio
         └────────────────────┘
```

## Why Pre-Recorded Audio Files?

Using WAV files instead of microphones provides several advantages for testing:

1. **Reproducibility**: Same audio content every run, making debugging consistent
2. **No Environment Noise**: Clean audio without background noise or microphone issues
3. **Known Content**: The transcript is known in advance, so transcription accuracy can be verified
4. **Automated Testing**: Can run in CI/CD pipelines without human intervention
5. **Dual-Stream Ready**: Each leg gets its own dedicated audio file (customer vs agent)
6. **Duration Control**: Audio files have fixed duration; tests complete predictably

## File Structure

```
client/
├── conversations/
│   └── escrow_demo_001.json          # Conversation metadata & transcript
├── audio/
│   ├── escrow_demo_001_customer.wav # Customer leg audio (8kHz, 16-bit, mono)
│   └── escrow_demo_001_agent.wav     # Agent leg audio (8kHz, 16-bit, mono)
└── src/
    └── automated-dual-call.ts        # Dual-stream client script
```

## Conversation JSON Format

The conversation JSON defines the scenario:

```json
{
  "conversation_id": "escrow_demo_001",
  "topic": "mortgage_escrow_increase",
  "participants": {
    "agent": {
      "name": "Sarah",
      "role": "customer_service_representative"
    },
    "customer": {
      "name": "John Miller"
    }
  },
  "transcript": [
    {
      "timestamp": "00:00:02",
      "speaker": "agent",
      "intent": "greeting",
      "text": "Hello, this is Sarah from Summit Mortgage. How can I help you today?"
    },
    {
      "timestamp": "00:00:05",
      "speaker": "customer",
      "intent": "state_issue",
      "text": "Hi Sarah, this is John Miller. I just got my annual escrow analysis, and my monthly payment is going up by almost two hundred dollars."
    }
  ]
}
```

The transcript serves as documentation/verification of what the audio contains. The timestamps are not currently used for playback synchronization.

## Usage

### Basic Command

```bash
cd /Users/servisbot/dev/audiohook-reference-implementation/client
npm run automated-dual-call -- \
  -c ./conversations/escrow_demo_001.json \
  -s ws://localhost:3000/api/v1/tccp/ws \
  -v
```

### Command Options

| Option | Description | Default |
|--------|-------------|---------|
| `-c, --conversation <file>` | Path to conversation JSON file | (required) |
| `-s, --server <url>` | AudioHook server WebSocket URL | `ws://localhost:3000/api/v1/tccp/ws` |
| `--customer-wav <file>` | Path to customer audio (overrides auto-detect) | Auto-detected from JSON |
| `--agent-wav <file>` | Path to agent audio (overrides auto-detect) | Auto-detected from JSON |
| `--organization-id <id>` | Organization ID (UUID format) | Auto-generated |
| `--api-key <key>` | API key for authentication | `test-api-key` |
| `--client-secret <secret>` | Client secret (base64) | None |
| `--delay <ms>` | Delay between starting legs | `500` ms |
| `-v, --verbose` | Enable verbose logging | false |

### Audio File Auto-Detection

If not specified via command line, audio files are auto-detected:
```
<conversationDir>/../audio/<conversation_id>_customer.wav
<conversationDir>/../audio/<conversation_id>_agent.wav
```

### Example with Custom Audio

```bash
npm run automated-dual-call -- \
  -c ./conversations/my_convo.json \
  --customer-wav ./custom/caller.wav \
  --agent-wav ./custom/receiver.wav \
  -s ws://localhost:3000/api/v1/tccp/ws
```

## How It Works

### 1. Session Creation

When the script runs:

1. **Generates a UUID** for the conversation (the JSON `conversation_id` is used for file naming only)
2. **Creates participant objects**:
   - Customer: UUID, ANI `+15551234567`, DNIS `+18001234567`
   - Agent: UUID, ANI `+18001234567`, DNIS `+15551234567`
3. **Starts customer leg first** (500ms delay before agent)
4. **Both legs share the same `conversationId`**

### 2. Server-Side Leg Assignment

The server's `ConversationManager` assigns roles:

- **First session** → `caller` (inbound) → AudioCodes `inbound` → `participant`
- **Second session** → `agent` (outbound) → AudioCodes `outbound` → `participant-2`

### 3. Audio Streaming

Each leg:
1. Reads its WAV file (8kHz, 16-bit PCM)
2. Transcodes to PCMU (μ-law)
3. Sends 200ms audio frames over WebSocket
4. Reports RTT via ping/pong

### 4. Transcription Flow

```
Customer Audio → Deepgram STT → TCCP Adapter → AudioCodes (participant)
Agent Audio    → Deepgram STT → TCCP Adapter → AudioCodes (participant-2)
```

## Audio File Requirements

- **Format**: WAV (RIFF)
- **Sample Rate**: 8000 Hz
- **Channels**: Mono (1) or Stereo (2)
- **Bit Depth**: 16-bit PCM
- **Duration**: Match between legs for best experience (or let one end early)

## Testing Multiple Scenarios

Create additional conversation directories:

```
conversations/
├── escrow_demo_001.json
├── support_call_001.json
└── sales_inquiry_002.json

audio/
├── escrow_demo_001_customer.wav
├── escrow_demo_001_agent.wav
├── support_call_001_customer.wav
├── support_call_001_agent.wav
├── sales_inquiry_002_customer.wav
└── sales_inquiry_002_agent.wav
```

Run different scenarios:
```bash
npm run automated-dual-call -- -c ./conversations/support_call_001.json
npm run automated-dual-call -- -c ./conversations/sales_inquiry_002.json
```

## Troubleshooting

### "Invalid/missing parameters" Error

This usually means the `organizationId` is not a valid UUID. The client now auto-generates valid UUIDs if not provided.

### Connection Refused

Ensure the server is running:
```bash
cd /Users/servisbot/dev/audiohook-reference-implementation/app
npm start
```

### Audio Not Playing

Check WAV file format:
```bash
file audio/your_file.wav
# Should show: RIFF (little-endian) data, WAVE audio, Microsoft PCM, 16 bit, mono 8000 Hz
```

### One Leg Missing

Check server logs for leg assignment. The first session is always `caller`, second is `agent`.

## Comparison: Microphone vs WAV File Testing

| Aspect | Microphone | WAV File |
|--------|-----------|----------|
| Setup | Requires audio hardware | File-based, no hardware |
| Reproducibility | Different every time | Identical every run |
| CI/CD Friendly | No | Yes |
| Dual-Stream | Complex (2 mics) | Simple (2 files) |
| Duration | Unlimited/variable | Fixed, known |
| Content | Unpredictable | Known, documented |
| Debugging | Hard (what was said?) | Easy (transcript in JSON) |

## Future Enhancements

Possible improvements to the automated dual-call system:

1. **Timestamp Synchronization**: Use transcript timestamps to pause/resume playback for realistic turn-taking
2. **Dynamic Mixing**: Mix both audio streams into a single stereo file for mono-channel testing
3. **Scenario Library**: Standard set of test scenarios (billing, support, sales, etc.)
4. **Metrics Collection**: Automatic STT accuracy measurement by comparing transcripts
5. **Redis Integration**: Distributed call tracking across multiple server instances

## See Also

- `client/src/automated-dual-call.ts` - Main client script
- `client/src/mediasource-wav.ts` - WAV file media source
- `app/src/tccp-integration/conversation-manager.ts` - Server-side leg management
- `app/src/tccp-integration/tccp-adapter.ts` - AudioCodes integration
