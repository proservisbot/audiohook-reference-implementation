output "instance_id" {
  description = "EC2 instance ID"
  value       = aws_instance.server.id
}

output "public_ip" {
  description = "Elastic IP address"
  value       = aws_eip.server.public_ip
}

output "webhook_url" {
  description = "Audiohook webhook URL"
  value       = "https://${var.domain}/audiohook"
}

output "https_url" {
  description = "HTTPS base URL"
  value       = "https://${var.domain}"
}

output "ssh_command" {
  description = "SSH command to connect to the instance"
  value       = "ssh -i ~/.ssh/${var.ssh_key_name}.pem ubuntu@${aws_eip.server.public_ip}"
}

output "dns_instructions" {
  description = "DNS configuration instructions"
  value       = "Create an A record for ${var.domain} pointing to ${aws_eip.server.public_ip}"
}

output "cloudwatch_app_logs" {
  description = "CloudWatch log group for app logs"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#logsV2:log-groups/log-group/%2F${var.project_name}%2Fapp"
}

output "cloudwatch_nginx_logs" {
  description = "CloudWatch log group for nginx logs"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#logsV2:log-groups/log-group/%2F${var.project_name}%2Fnginx"
}

output "cloudwatch_setup_logs" {
  description = "CloudWatch log group for setup/user-data logs"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#logsV2:log-groups/log-group/%2F${var.project_name}%2Fsetup"
}
