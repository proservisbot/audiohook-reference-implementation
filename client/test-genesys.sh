#!/bin/bash
# Test script for Genesys AudioHook server with JWT authentication
# Usage: ./test-genesys.sh [wav-file] [auth-mode]
# auth-mode: jwt (default) or legacy

SERVER_URI="wss://genesys-adapter.servismix.com/api/v1/tccp/ws"
API_KEY="xHx4oIIN0zt5SckgdDnjDaEn6P"
CLIENT_SECRET="YXJyYW5nZW1lbnRjcm9wbm90bGVhdGhlcnJlcGxpZWR0ZWxlcGhvbmVwYXJhbGxlbGw="
WAV_FILE="${1:-audio/escrow_demo_001_agent.wav}"
AUTH_MODE="${2:-jwt}"

echo "============================================"
echo "  Genesys AudioHook Server Test"
echo "============================================"
echo "Server:       $SERVER_URI"
echo "WAV File:     $WAV_FILE"
echo "Auth Mode:    $AUTH_MODE"

if [ "$AUTH_MODE" = "jwt" ]; then
    echo "Client Secret: [REDACTED]"
else
    echo "API Key:      $API_KEY"
fi
echo "============================================"
echo ""

# Health check first
echo "Checking server health..."
HEALTH=$(curl -s https://genesys-adapter.servismix.com/health/check)
echo "Health: $HEALTH"
echo ""

if echo "$HEALTH" | grep -q '"Healthy":true'; then
    echo "Server is healthy. Starting audio stream with $AUTH_MODE authentication..."
    echo ""
    
    if [ "$AUTH_MODE" = "jwt" ]; then
        echo "Using JWT authentication..."
        export AUDIOHOOK_AUTH_MODE=jwt
        npm start -- \
            --uri "$SERVER_URI" \
            --wavfile "$WAV_FILE" \
            --api-key "$API_KEY" \
            --client-secret "$CLIENT_SECRET"
    else
        echo "Using legacy API key authentication..."
        export AUDIOHOOK_AUTH_MODE=legacy
        npm start -- \
            --uri "$SERVER_URI" \
            --wavfile "$WAV_FILE" \
            --api-key "$API_KEY" \
            --client-secret "$CLIENT_SECRET"
    fi
else
    echo "ERROR: Server health check failed!"
    exit 1
fi
