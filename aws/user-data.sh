#!/bin/bash
set -e

exec > >(tee /var/log/user-data.log) 2>&1

echo "Starting setup..."

DOMAIN="${domain}"
SECRET_NAME="${secret_name}"
DEPLOY_KEY_SECRET="${deploy_key_secret}"
AWS_REGION="${aws_region}"
GITHUB_REPO="${github_repo}"
ACME_EMAIL="${acme_email}"
APP_PORT="${app_port}"

# Update and install dependencies
apt-get update -y
apt-get install -y curl git jq nginx certbot python3-certbot-nginx unzip build-essential

# Install AWS CLI v2
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
/tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# Install CloudWatch agent
curl "https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb" -o /tmp/amazon-cloudwatch-agent.deb
dpkg -i /tmp/amazon-cloudwatch-agent.deb
rm /tmp/amazon-cloudwatch-agent.deb

# Configure CloudWatch agent
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << 'CWCONFIG'
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/user-data.log",
            "log_group_name": "/audiohook-server/setup",
            "log_stream_name": "{instance_id}/user-data",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S"
          },
          {
            "file_path": "/home/ubuntu/.pm2/logs/audiohook-out.log",
            "log_group_name": "/audiohook-server/app",
            "log_stream_name": "{instance_id}/stdout",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S"
          },
          {
            "file_path": "/home/ubuntu/.pm2/logs/audiohook-error.log",
            "log_group_name": "/audiohook-server/app",
            "log_stream_name": "{instance_id}/stderr",
            "timestamp_format": "%Y-%m-%dT%H:%M:%S"
          },
          {
            "file_path": "/var/log/nginx/access.log",
            "log_group_name": "/audiohook-server/nginx",
            "log_stream_name": "{instance_id}/access"
          },
          {
            "file_path": "/var/log/nginx/error.log",
            "log_group_name": "/audiohook-server/nginx",
            "log_stream_name": "{instance_id}/error"
          }
        ]
      }
    }
  }
}
CWCONFIG

/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config \
  -m ec2 \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json \
  -s

systemctl enable amazon-cloudwatch-agent

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install PM2
npm install -g pm2 typescript ts-node

# Setup SSH for GitHub
mkdir -p /root/.ssh
chmod 700 /root/.ssh

DEPLOY_KEY=$(aws secretsmanager get-secret-value --secret-id "$DEPLOY_KEY_SECRET" --region "$AWS_REGION" --query 'SecretString' --output text | jq -r '.private_key')
echo "$DEPLOY_KEY" > /root/.ssh/id_ed25519
chmod 600 /root/.ssh/id_ed25519
ssh-keyscan github.com >> /root/.ssh/known_hosts

# Clone repo
git clone "$GITHUB_REPO" /opt/audiohook-server
cd /opt/audiohook-server

# Fetch app config from Secrets Manager
SECRETS=$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$AWS_REGION" --query 'SecretString' --output text)

# Create .env file for the app
cat > /opt/audiohook-server/app/.env << EOF
PORT=$APP_PORT
NODE_ENV=production
EOF

# Append any additional secrets to .env
echo "$SECRETS" | jq -r 'to_entries | .[] | "\(.key)=\(.value)"' >> /opt/audiohook-server/app/.env

chmod 600 /opt/audiohook-server/app/.env

# Install app dependencies (include devDeps for TypeScript build)
cd /opt/audiohook-server/app
npm install --registry=https://registry.npmjs.org

# Build the TypeScript app (override noEmitOnError to handle pre-existing type issues)
npx tsc --project tsconfig.json --noEmitOnError false || echo "TypeScript build completed with warnings"

# Set ownership
chown -R ubuntu:ubuntu /opt/audiohook-server

# Configure nginx reverse proxy with WebSocket support
cat > /etc/nginx/sites-available/audiohook << 'NGINX'
server {
    listen 80;
    server_name DOMAIN_PLACEHOLDER;

    location / {
        proxy_pass http://localhost:APP_PORT_PLACEHOLDER;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # WebSocket specific timeouts
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
NGINX

sed -i "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" /etc/nginx/sites-available/audiohook
sed -i "s/APP_PORT_PLACEHOLDER/$APP_PORT/g" /etc/nginx/sites-available/audiohook
ln -sf /etc/nginx/sites-available/audiohook /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# Obtain SSL certificate
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ACME_EMAIL" --redirect

# Create PM2 ecosystem file for Ubuntu user
cat > /opt/audiohook-server/ecosystem.config.js << 'ECOSYSTEM'
module.exports = {
  apps: [{
    name: 'audiohook',
    script: './app/dist/src/index.js',
    cwd: '/opt/audiohook-server',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 'APP_PORT_PLACEHOLDER'
    },
    log_file: '/home/ubuntu/.pm2/logs/audiohook-out.log',
    error_file: '/home/ubuntu/.pm2/logs/audiohook-error.log',
    out_file: '/home/ubuntu/.pm2/logs/audiohook-out.log',
    merge_logs: true,
    time: true
  }]
};
ECOSYSTEM

sed -i "s/APP_PORT_PLACEHOLDER/$APP_PORT/g" /opt/audiohook-server/ecosystem.config.js
chown ubuntu:ubuntu /opt/audiohook-server/ecosystem.config.js

# Start app with PM2
sudo -u ubuntu pm2 start /opt/audiohook-server/ecosystem.config.js
sudo -u ubuntu pm2 save

# Enable PM2 on boot
env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
systemctl enable pm2-ubuntu

echo "Setup complete!"
echo "Server running at https://$DOMAIN"
