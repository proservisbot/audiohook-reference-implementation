# Audiohook Integration - Genesys Cloud Setup

Your audiohook server is live and ready for integration with Genesys Cloud.

## Connection Details

| Setting | Value |
|---------|-------|
| **WebSocket URI** | `wss://genesys-adapter.servismix.com/api/v1/tccp/ws` |
| **API Key** | `xHx4oIIN0zt5SckgdDnjDaEn6P` |
| **Protocol** | AudioHook (WebSocket) |
| **Audio Format** | PCMU, 8kHz |
| **Health Check** | `https://genesys-adapter.servismix.com/health/check` |

## Genesys Cloud Configuration Steps

1. **Navigate to** Admin → Integrations → Add Integration
2. **Search for** "AudioHook" and select it
3. **Configure the integration:**
   - **Connection URI**: `wss://genesys-adapter.servismix.com/api/v1/tccp/ws`
   - **API Key**: `xHx4oIIN0zt5SckgdDnjDaEn6P`
   - **Client Secret**: *(leave empty)*
4. **Set the channel** to `external` (single channel) or configure dual-stream as needed
5. **Activate** the integration
6. **Assign to queues/flows** where you want real-time transcription

## What It Does

- Receives real-time audio streams from Genesys Cloud via the AudioHook protocol
- Performs live transcription using Deepgram (nova-2 model)
- Transcription events are logged and available via CloudWatch

## Verification

You can verify the server is healthy at any time:
```
curl https://genesys-adapter.servismix.com/health/check
```
Expected response: `{"Http-Status":200,"Healthy":true}`

## Notes

- No client secret / signature is required — the API key alone authenticates the connection
- The server supports multiple concurrent sessions
- SSL is handled automatically (Let's Encrypt)
