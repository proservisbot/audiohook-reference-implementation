aws_region   = "us-east-1"
aws_profile  = "024124091015_SherpaPowerUser"
project_name = "audiohook-server"
instance_type = "t3.small"

# Domain for the server (must have DNS pointing to the elastic IP)
domain = "genisys-adapter.servismix.com"

# Email for Let's Encrypt certificate notifications
acme_email = "diarmuid.wrenne@servisbot.com"

# AWS Secrets Manager secret names
secret_name       = "audiohook-server/config"
deploy_key_secret = "audiohook-server/deploy-key"

# GitHub repository SSH URL
github_repo = "git@github.com:proservisbot/audiohook-reference-implementation.git"

# Name of existing EC2 key pair in us-east-1
ssh_key_name = "audiohook-server"

# Existing VPC (shared with jambonz-siprec)
vpc_id = "vpc-04b16fb3bf0331aa2"

# Restrict SSH access to your IP
allowed_ssh_cidr = "0.0.0.0/0"

# Restrict HTTPS to specific IPs (Genesys + admin)
allowed_https_cidrs = [
  "98.91.169.216/32",
  "44.219.169.108/32",
  "3.86.215.11/32",
  "91.142.239.226/32",
  "149.88.96.50/32"
]

# Application port
app_port = 3000
