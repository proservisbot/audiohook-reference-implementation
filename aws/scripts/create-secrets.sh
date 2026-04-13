#!/bin/bash
set -e

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-024124091015_SherpaPowerUser}"
SECRET_NAME="${SECRET_NAME:-audiohook-server/config}"
DEPLOY_KEY_SECRET="${DEPLOY_KEY_SECRET:-audiohook-server/deploy-key}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Creating AWS Secrets for Audiohook Server${NC}"
echo "Region: $AWS_REGION"
echo "Profile: $AWS_PROFILE"
echo ""

# Generate SSH deploy key
echo -e "${YELLOW}Generating SSH deploy key...${NC}"
TEMP_DIR=$(mktemp -d)
ssh-keygen -t ed25519 -C "deploy@$(hostname)" -f "$TEMP_DIR/deploy_key" -N ""

PRIVATE_KEY=$(cat "$TEMP_DIR/deploy_key")
PUBLIC_KEY=$(cat "$TEMP_DIR/deploy_key.pub")

# Create or update deploy key secret
echo -e "${YELLOW}Storing deploy key in Secrets Manager...${NC}"
DEPLOY_KEY_JSON=$(jq -n --arg key "$PRIVATE_KEY" '{private_key: $key}')

aws secretsmanager create-secret \
    --name "$DEPLOY_KEY_SECRET" \
    --description "GitHub deploy key for audiohook server" \
    --secret-string "$DEPLOY_KEY_JSON" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" 2>/dev/null || \
aws secretsmanager put-secret-value \
    --secret-id "$DEPLOY_KEY_SECRET" \
    --secret-string "$DEPLOY_KEY_JSON" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE"

echo -e "${GREEN}Deploy key secret created/updated: $DEPLOY_KEY_SECRET${NC}"

# Create or update app config secret
echo -e "${YELLOW}Creating app config secret...${NC}"
APP_CONFIG=$(jq -n '{
    TRANSCRIPTION_SERVICE: "deepgram",
    DEEPGRAM_API_KEY: "your-deepgram-api-key",
    DEEPGRAM_MODEL: "nova-2",
    AUDIOCODES_BOT_URL: "",
    AUDIOCODES_API_KEY: "",
    EVENT_WEBHOOK_URL: ""
}')

aws secretsmanager create-secret \
    --name "$SECRET_NAME" \
    --description "Audiohook server configuration" \
    --secret-string "$APP_CONFIG" \
    --region "$AWS_REGION" \
    --profile "$AWS_PROFILE" 2>/dev/null || \
echo -e "${YELLOW}App config secret already exists: $SECRET_NAME${NC}"

echo -e "${GREEN}App config secret: $SECRET_NAME${NC}"

# Cleanup
rm -rf "$TEMP_DIR"

# Output instructions
echo ""
echo -e "${GREEN}=== Setup Complete ===${NC}"
echo ""
echo -e "${YELLOW}Add this public key to GitHub:${NC}"
echo "Repository: https://github.com/proservisbot/audiohook-reference-implementation/settings/keys"
echo ""
echo "----- BEGIN PUBLIC KEY -----"
echo "$PUBLIC_KEY"
echo "----- END PUBLIC KEY -----"
echo ""
echo -e "${YELLOW}Update your app config in AWS Console:${NC}"
echo "https://$AWS_REGION.console.aws.amazon.com/secretsmanager/secret?name=$SECRET_NAME"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Add the public key to GitHub repo settings"
echo "2. Update the app config secret with your actual values"
echo "3. Run: terraform init && terraform apply"
