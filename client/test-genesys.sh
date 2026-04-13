#!/bin/bash
# Test script for Genesys AudioHook server
# Usage: ./test-genesys.sh [wav-file]

SERVER_URI="wss://genesys-adapter.servismix.com/api/v1/tccp/ws"
API_KEY="xHx4oIIN0zt5SckgdDnjDaEn6P"
WAV_FILE="${1:-audio/escrow_demo_001_agent.wav}"

echo "============================================"
echo "  Genesys AudioHook Server Test"
echo "============================================"
echo "Server:   $SERVER_URI"
echo "API Key:  $API_KEY"
echo "WAV File: $WAV_FILE"
echo "============================================"
echo ""

# Health check first
echo "Checking server health..."
HEALTH=$(curl -s https://genesys-adapter.servismix.com/health/check)
echo "Health: $HEALTH"
echo ""

if echo "$HEALTH" | grep -q '"Healthy":true'; then
    echo "Server is healthy. Starting audio stream..."
    echo ""
    npm start -- \
        --uri "$SERVER_URI" \
        --wavfile "$WAV_FILE" \
        --api-key "$API_KEY"
else
    echo "ERROR: Server health check failed!"
    exit 1
fi
