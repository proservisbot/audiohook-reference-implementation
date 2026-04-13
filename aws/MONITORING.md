# Audiohook Server - Monitoring & Logs

## CloudWatch Log Groups

| Log Group | Description | Console Link |
|-----------|-------------|--------------|
| **App Logs** | Application stdout/stderr (transcripts, sessions, errors) | [Open in CloudWatch](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/%2Faudiohook-server%2Fapp) |
| **Nginx Logs** | HTTP access and error logs | [Open in CloudWatch](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/%2Faudiohook-server%2Fnginx) |
| **Setup Logs** | EC2 instance setup / user-data output | [Open in CloudWatch](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/%2Faudiohook-server%2Fsetup) |

## Useful CloudWatch Filter Patterns

Use these in the CloudWatch console or CLI to filter app logs:

| What | Filter Pattern |
|------|---------------|
| Transcripts only | `"Final transcript"` |
| Session open/close | `"Session open" OR "Session closed"` |
| Deepgram events | `"Deepgram"` |
| Errors | `"level\":50` |
| Health checks | `"/health/check"` |

## Scripts

### View recent transcripts (recommended)
```bash
# Last 30 minutes, 20 transcripts (default)
./aws/scripts/view-transcripts.sh

# Last 2 hours, 50 transcripts
./aws/scripts/view-transcripts.sh 120 50

# Last 24 hours, 100 transcripts
./aws/scripts/view-transcripts.sh 1440 100
```

### Test the server
```bash
cd client
./test-genesys.sh
```

## CLI Commands

**Prerequisites:** AWS CLI configured with profile `024124091015_SherpaPowerUser`.

### View recent transcripts (raw)
```bash
aws logs filter-log-events \
  --log-group-name /audiohook-server/app \
  --filter-pattern '"Final transcript"' \
  --region us-east-1 \
  --profile 024124091015_SherpaPowerUser \
  --limit 20 \
  --query 'events[*].message' \
  --output text
```

### View recent errors
```bash
aws logs filter-log-events \
  --log-group-name /audiohook-server/app \
  --filter-pattern '"level\":50' \
  --region us-east-1 \
  --profile 024124091015_SherpaPowerUser \
  --limit 20 \
  --query 'events[*].message' \
  --output text
```

### View all app logs (last hour)
```bash
aws logs filter-log-events \
  --log-group-name /audiohook-server/app \
  --start-time $(date -v-1H +%s000) \
  --region us-east-1 \
  --profile 024124091015_SherpaPowerUser \
  --query 'events[*].message' \
  --output text
```

### View nginx access logs
```bash
aws logs filter-log-events \
  --log-group-name /audiohook-server/nginx \
  --log-stream-name-prefix "$(aws ec2 describe-instances \
    --filters 'Name=tag:Name,Values=audiohook-server-server' 'Name=instance-state-name,Values=running' \
    --query 'Reservations[0].Instances[0].InstanceId' \
    --output text --region us-east-1 --profile 024124091015_SherpaPowerUser)/access" \
  --region us-east-1 \
  --profile 024124091015_SherpaPowerUser \
  --limit 20 \
  --query 'events[*].message' \
  --output text
```

### Tail logs live (via SSH)
```bash
ssh -i ~/.ssh/audiohook-server.pem ubuntu@34.206.236.146 "pm2 logs audiohook"
```

## Server Access

| Resource | Value |
|----------|-------|
| **SSH** | `ssh -i ~/.ssh/audiohook-server.pem ubuntu@34.206.236.146` |
| **Health Check** | `curl https://genesys-adapter.servismix.com/health/check` |
| **PM2 Status** | `pm2 status` (after SSH) |
| **PM2 Logs** | `pm2 logs audiohook` (after SSH) |
| **Instance ID** | Check `terraform output` in `aws/` directory |
