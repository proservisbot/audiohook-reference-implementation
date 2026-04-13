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

echo -e "${GREEN}Fetching sessions and transcripts...${NC}"
echo ""

# Temp files for processing
TMPDIR=$(mktemp -d)
SESSIONS_FILE="$TMPDIR/sessions.json"
TRANSCRIPTS_FILE="$TMPDIR/transcripts.json"
trap "rm -rf $TMPDIR" EXIT

# Fetch session completion events
aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern '"Transcription completed"' \
    --start-time "$START_TIME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --limit 20 \
    --output json | jq '[.events[].message | sub("^[^{]*"; "") | fromjson] | unique_by(.session) | sort_by(.time)' > "$SESSIONS_FILE"

# Fetch transcript events
aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern '"Final transcript"' \
    --start-time "$START_TIME" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" \
    --limit $(( LIMIT * 2 )) \
    --output json | jq '[.events[].message | sub("^[^{]*"; "") | fromjson] | unique_by(.time, .transcript) | sort_by(.time)' > "$TRANSCRIPTS_FILE"

# Process sessions and their transcripts using jq
NUM_SESSIONS=$(jq 'length' "$SESSIONS_FILE")

if [ "$NUM_SESSIONS" = "0" ]; then
    echo -e "  ${YELLOW}No sessions found in the last ${MINUTES_AGO} minutes${NC}"
else
    for i in $(seq 0 $(( NUM_SESSIONS - 1 ))); do
        SESSION_ID=$(jq -r ".[$i].session" "$SESSIONS_FILE")
        COUNT=$(jq -r ".[$i].transcriptCount" "$SESSIONS_FILE")
        CHUNKS=$(jq -r ".[$i].audioChunks" "$SESSIONS_FILE")
        CLOSE_TIME=$(jq -r ".[$i].time" "$SESSIONS_FILE")

        # Estimate open time as close_time minus 5 minutes
        OPEN_TIME=$(( CLOSE_TIME - 300000 ))

        echo -e "${YELLOW}--------------------------------------------${NC}"
        echo -e "  Session: ${CYAN}${SESSION_ID}${NC}"
        echo -e "  Transcripts: ${COUNT}  |  Audio Chunks: ${CHUNKS}"
        echo ""

        # Find transcripts within this session's time window
        jq -r --argjson open "$OPEN_TIME" --argjson close "$CLOSE_TIME" \
            '.[] | select(.time >= $open and .time <= ($close + 2000)) | "\(.time)|\(.transcript)|\(.confidence)"' \
            "$TRANSCRIPTS_FILE" | sort -n | while IFS='|' read -r EPOCH TEXT CONF; do
                [ -z "$TEXT" ] && continue
                # Convert epoch ms to readable timestamp
                if [[ "$OSTYPE" == "darwin"* ]]; then
                    TS=$(date -r $(( EPOCH / 1000 )) -u "+%Y-%m-%dT%H:%M:%S")
                else
                    TS=$(date -d @$(( EPOCH / 1000 )) -u "+%Y-%m-%dT%H:%M:%S")
                fi
                echo -e "    ${CYAN}[${TS}]${NC} (${CONF}) ${TEXT}"
            done
        echo ""
    done
fi

echo -e "${YELLOW}============================================${NC}"
echo -e "  CloudWatch Console:"
echo -e "  ${CYAN}https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/%2Faudiohook-server%2Fapp${NC}"
echo -e "${YELLOW}============================================${NC}"
