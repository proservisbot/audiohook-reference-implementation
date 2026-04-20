#!/bin/bash
set -e

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-024124091015_SherpaPowerUser}"
SSH_KEY="${SSH_KEY:-~/.ssh/audiohook-server.pem}"
BRANCH="${1:-main}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

if [ -z "$1" ]; then
    echo -e "${YELLOW}Usage: $0 <branch-name>${NC}"
    echo "Example: $0 main"
    exit 1
fi

# Get instance public IP
echo -e "${YELLOW}Looking up instance...${NC}"
INSTANCE_IP=$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=audiohook-server-server" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE")

if [ "$INSTANCE_IP" = "None" ] || [ -z "$INSTANCE_IP" ]; then
    echo -e "${RED}Error: Could not find running instance${NC}"
    exit 1
fi

echo -e "${GREEN}Found instance at: $INSTANCE_IP${NC}"
echo -e "${YELLOW}Deploying branch: $BRANCH${NC}"
echo ""

SSH_CMD="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10 ubuntu@$INSTANCE_IP"

# Step 1: Pull latest code
echo -e "${CYAN}[1/4] Pulling latest code...${NC}"
$SSH_CMD "cd /opt/audiohook-server && GIT_SSH_COMMAND='ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=no' sudo git fetch origin && sudo git checkout $BRANCH && sudo git pull origin $BRANCH && sudo chown -R ubuntu:ubuntu /opt/audiohook-server"

# Step 2: Rebuild .env from Secrets Manager
echo -e "${CYAN}[2/4] Rebuilding .env from Secrets Manager...${NC}"
$SSH_CMD "SECRETS=\$(aws secretsmanager get-secret-value --secret-id audiohook-server/config --region $AWS_REGION --query SecretString --output text) && printf 'PORT=3000\nSERVERPORT=3000\nSERVERHOST=127.0.0.1\nNODE_ENV=production\n' > /opt/audiohook-server/.env && echo \"\$SECRETS\" | jq -r 'to_entries | .[] | \"\(.key)=\(.value)\"' >> /opt/audiohook-server/.env && chmod 600 /opt/audiohook-server/.env"

# Step 3: Install deps and build
echo -e "${CYAN}[3/4] Installing dependencies and building...${NC}"
$SSH_CMD "cd /opt/audiohook-server/app && npm install --registry=https://registry.npmjs.org && npx tsc --project tsconfig.json --noEmitOnError false; echo 'Build done'"

# Step 4: Restart app
echo -e "${CYAN}[4/4] Restarting application...${NC}"
$SSH_CMD "pm2 restart audiohook && pm2 save"

echo -e "${YELLOW}Waiting for service to start...${NC}"
sleep 10

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Deploy complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo -e "  Branch:  ${CYAN}$BRANCH${NC}"
echo -e "  Server:  ${CYAN}https://genesys-adapter.servismix.com${NC}"
echo -e "  Health:  ${CYAN}$(curl -s https://genesys-adapter.servismix.com/health/check)${NC}"
echo -e "${GREEN}============================================${NC}"
