variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "aws_profile" {
  description = "AWS CLI profile name"
  type        = string
  default     = "default"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "audiohook-server"
}

variable "instance_type" {
  description = "EC2 instance type"
  type        = string
  default     = "t3.small"
}

variable "domain" {
  description = "Domain name for the server (used for SSL certificate)"
  type        = string
}

variable "acme_email" {
  description = "Email address for Let's Encrypt certificate notifications"
  type        = string
}

variable "secret_name" {
  description = "AWS Secrets Manager secret name containing app config"
  type        = string
  default     = "audiohook-server/config"
}

variable "deploy_key_secret" {
  description = "AWS Secrets Manager secret name containing GitHub deploy key"
  type        = string
  default     = "audiohook-server/deploy-key"
}

variable "github_repo" {
  description = "GitHub repository SSH URL"
  type        = string
}

variable "ssh_key_name" {
  description = "Name of existing EC2 key pair for SSH access"
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR block allowed for SSH access"
  type        = string
  default     = "0.0.0.0/0"
}

variable "allowed_https_cidrs" {
  description = "List of CIDR blocks allowed for HTTPS/WebSocket access"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "vpc_id" {
  description = "ID of an existing VPC to deploy into"
  type        = string
}

variable "app_port" {
  description = "Port the application runs on"
  type        = number
  default     = 3000
}
