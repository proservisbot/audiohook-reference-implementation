#!/bin/bash
# View recent transcription events from CloudWatch
# Usage: ./view-transcripts.sh [minutes-ago] [limit]
# Example: ./view-transcripts.sh 60 50

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-024124091015_SherpaPowerUser}"
LOG_GROUP="/audiohook-server/app"
MINUTES_AGO="${1:-30}"
LIMIT="${2:-20}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Calculate start time
if [[ "$OSTYPE" == "darwin"* ]]; then
    START_TIME=$(date -v-${MINUTES_AGO}M +%s000)
else
    START_TIME=$(date -d "${MINUTES_AGO} minutes ago" +%s000)
fi

echo -e "${YELLOW}============================================${NC}"
echo -e "${YELLOW}  Audiohook Transcription Events${NC}"
echo -e "${YELLOW}============================================${NC}"
echo -e "  Log Group:  ${CYAN}${LOG_GROUP}${NC}"
echo -e "  Time Range: ${CYAN}Last ${MINUTES_AGO} minutes${NC}"
echo -e "  Limit:      ${CYAN}${LIMIT} events${NC}"
echo -e "${YELLOW}============================================${NC}"
echo ""

# Fetch transcripts
echo -e "${GREEN}Fetching final transcripts...${NC}"
echo ""

aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern '"Final transcript"' \
    --start-time "$START_TIME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --limit "$LIMIT" \
    --output json | jq -r '.events[].message' | sort -u | while IFS= read -r line; do
        # Extract timestamp, transcript and confidence from JSON log line
        TIMESTAMP=$(echo "$line" | sed -n 's/^\([0-9T:-]*\):.*/\1/p')
        JSON=$(echo "$line" | sed 's/^[^{]*//')
        TRANSCRIPT=$(echo "$JSON" | jq -r '.transcript // empty' 2>/dev/null)
        CONFIDENCE=$(echo "$JSON" | jq -r '.confidence // empty' 2>/dev/null)
        
        if [ -n "$TRANSCRIPT" ]; then
            echo -e "  ${CYAN}[${TIMESTAMP}]${NC} (${CONFIDENCE}) ${TRANSCRIPT}"
        fi
    done

echo ""
echo -e "${YELLOW}--------------------------------------------${NC}"

# Session summary
echo -e "${GREEN}Recent sessions:${NC}"
echo ""

aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern '"Transcription completed"' \
    --start-time "$START_TIME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --limit 10 \
    --output json | jq -r '.events[].message' | sort -u | while IFS= read -r line; do
        JSON=$(echo "$line" | sed 's/^[^{]*//')
        SESSION=$(echo "$JSON" | jq -r '.session // empty' 2>/dev/null)
        COUNT=$(echo "$JSON" | jq -r '.transcriptCount // empty' 2>/dev/null)
        CHUNKS=$(echo "$JSON" | jq -r '.audioChunks // empty' 2>/dev/null)
        
        if [ -n "$SESSION" ]; then
            echo -e "  Session: ${CYAN}${SESSION}${NC}"
            echo -e "    Transcripts: ${COUNT}, Audio Chunks: ${CHUNKS}"
        fi
    done

echo ""
echo -e "${YELLOW}============================================${NC}"
echo -e "  CloudWatch Console:"
echo -e "  ${CYAN}https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/%2Faudiohook-server%2Fapp${NC}"
echo -e "${YELLOW}============================================${NC}"
