# AWS EC2 Deployment

Terraform configuration to deploy the Audiohook server to AWS EC2 with nginx reverse proxy and automatic Let's Encrypt SSL.

## Architecture

- **EC2 Instance**: Ubuntu 24.04 `t3.small`
- **Node.js 20** + **PM2**: Process manager with auto-restart
- **nginx**: Reverse proxy with WebSocket support (port 443 → localhost:3000)
- **Let's Encrypt**: Automatic SSL via certbot
- **Elastic IP**: Static IP address
- **AWS Secrets Manager**: Stores deploy key and app config

## Prerequisites

- AWS CLI installed and configured
- Terraform >= 1.0
- EC2 key pair created in your AWS region
- Domain name with DNS control

## File Structure

```
aws/
├── main.tf                  # Main Terraform configuration
├── variables.tf             # Variable definitions
├── outputs.tf               # Output definitions
├── user-data.sh             # EC2 initialization script
├── terraform.tfvars.example # Example variables file
├── README.md                # This file
└── scripts/                 # Helper scripts
    ├── create-secrets.sh    # Create AWS Secrets Manager secrets
    └── deploy.sh            # Deploy script for updates
```

## Quick Start

### 1. Create AWS Secrets

```bash
cd aws/scripts
chmod +x create-secrets.sh
./create-secrets.sh
```

This generates an SSH deploy key pair, stores the private key in Secrets Manager, and outputs the public key to add to GitHub.

Add the public key at: `https://github.com/proservisbot/audiohook-reference-implementation/settings/keys`

### 2. Create EC2 Key Pair

```bash
aws ec2 create-key-pair \
  --key-name audiohook-server \
  --query 'KeyMaterial' \
  --output text \
  --region us-east-1 \
  --profile YOUR_PROFILE > ~/.ssh/audiohook-server.pem

chmod 400 ~/.ssh/audiohook-server.pem
```

### 3. Configure Terraform

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
```

### 4. Deploy Infrastructure

```bash
cd aws
terraform init
terraform plan
terraform apply
```

### 5. Configure DNS

Create an A record pointing your domain to the Elastic IP shown in the Terraform outputs.

### 6. Verify

```bash
# SSH into the instance
ssh -i ~/.ssh/audiohook-server.pem ubuntu@<ELASTIC_IP>

# View setup log
sudo tail -f /var/log/user-data.log

# Check PM2 status
pm2 status

# View app logs
pm2 logs audiohook
```

## Deploy Updates

To deploy a new version or branch:

```bash
./scripts/deploy.sh <branch-name>
```

Examples:
```bash
./scripts/deploy.sh main
./scripts/deploy.sh feature/aws-ec2-deploy
```

## Genesys Audiohook Configuration

In Genesys Cloud, configure your Audiohook integration to point to:

```
https://<your-domain>/audiohook
```

The server supports WebSocket connections for streaming audio.

## Troubleshooting

```bash
# nginx status
sudo systemctl status nginx

# nginx logs
sudo tail -f /var/log/nginx/error.log

# certbot certificate
sudo certbot certificates

# restart app
pm2 restart audiohook

# view CloudWatch logs
aws logs tail /audiohook-server/app --follow
```

## Cleanup

```bash
terraform destroy
```

## Outputs

| Output | Description |
|--------|-------------|
| `instance_id` | EC2 instance ID |
| `public_ip` | Elastic IP address |
| `webhook_url` | Audiohook webhook URL |
| `https_url` | HTTPS base URL |
| `ssh_command` | SSH command to connect |
| `dns_instructions` | DNS configuration instructions |
| `cloudwatch_app_logs` | CloudWatch link for app logs |
| `cloudwatch_nginx_logs` | CloudWatch link for nginx logs |
| `cloudwatch_setup_logs` | CloudWatch link for setup logs |
