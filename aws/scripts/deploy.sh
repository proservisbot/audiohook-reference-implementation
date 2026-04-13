#!/bin/bash
set -e

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-024124091015_SherpaPowerUser}"
INSTANCE_TAG="${INSTANCE_TAG:-audiohook-server-server}"
BRANCH="${1:-main}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ -z "$1" ]; then
    echo -e "${YELLOW}Usage: $0 <branch-name>${NC}"
    echo "Example: $0 main"
    exit 1
fi

echo -e "${YELLOW}Deploying branch: $BRANCH${NC}"

# Get instance ID
INSTANCE_ID=$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$INSTANCE_TAG" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE")

if [ "$INSTANCE_ID" = "None" ] || [ -z "$INSTANCE_ID" ]; then
    echo -e "${RED}Error: Could not find running instance with tag Name=$INSTANCE_TAG${NC}"
    exit 1
fi

echo -e "${GREEN}Found instance: $INSTANCE_ID${NC}"

# Deploy via SSM
DEPLOY_COMMAND=$(cat << 'EOF'
cd /opt/audiohook-server && \
sudo -u ubuntu git fetch origin && \
sudo -u ubuntu git checkout BRANCH_PLACEHOLDER && \
sudo -u ubuntu git pull origin BRANCH_PLACEHOLDER && \

# Rebuild .env from Secrets Manager
SECRETS=$(aws secretsmanager get-secret-value --secret-id "audiohook-server/config" --region "AWS_REGION_PLACEHOLDER" --query 'SecretString' --output text) && \
cat > /opt/audiohook-server/.env << ENVEOF
PORT=3000
SERVERPORT=3000
SERVERHOST=127.0.0.1
NODE_ENV=production
ENVEOF
echo "$SECRETS" | jq -r 'to_entries | .[] | "\(.key)=\(.value)"' >> /opt/audiohook-server/.env && \
chmod 600 /opt/audiohook-server/.env && \
chown ubuntu:ubuntu /opt/audiohook-server/.env && \

# Install deps and build
cd /opt/audiohook-server/app && \
sudo -u ubuntu npm install --registry=https://registry.npmjs.org && \
sudo -u ubuntu npx tsc --project tsconfig.json --noEmitOnError false; \

# Restart app
sudo -u ubuntu pm2 restart audiohook && \
sudo -u ubuntu pm2 save && \
echo "Deploy complete"
EOF
)

DEPLOY_COMMAND=$(echo "$DEPLOY_COMMAND" | sed "s/BRANCH_PLACEHOLDER/$BRANCH/g" | sed "s/AWS_REGION_PLACEHOLDER/$AWS_REGION/g")

echo -e "${YELLOW}Running deploy command via SSM...${NC}"

aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Deploy branch $BRANCH" \
    --parameters commands="$DEPLOY_COMMAND" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE"

echo -e "${GREEN}Deploy command sent. Check SSM console for status.${NC}"
echo "https://$AWS_REGION.console.aws.amazon.com/systems-manager/run-command?region=$AWS_REGION"
