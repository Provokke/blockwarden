output "table_name" {
  description = "DynamoDB table name."
  value       = aws_dynamodb_table.main.name
}

output "table_arn" {
  description = "DynamoDB table ARN, for modules that share the table such as the relayer."
  value       = aws_dynamodb_table.main.arn
}

output "table_stream_arn" {
  description = "Stream consumed by the actions dispatcher in a later milestone."
  value       = aws_dynamodb_table.main.stream_arn
}

output "monitor_function_names" {
  description = "Monitor Lambda function name per chain."
  value       = { for key, f in aws_lambda_function.monitor : key => f.function_name }
}

output "alarm_topic_arn" {
  description = "SNS topic that receives every alarm."
  # Built from the topic's name, which is known at plan, rather than read from the topic, which is not until it
  # exists: modules/relayer decides whether to create its own topic by whether this is null, and on a first plan
  # an unknown ARN makes that count unknown and the plan fails.
  value = "arn:${local.partition}:sns:${local.region}:${local.account_id}:${aws_sns_topic.alarms.name}"
}

output "delivery_queue_url" {
  description = "Queue the actions dispatcher puts delivery pointers on."
  value       = var.actions == null ? null : module.actions[0].delivery_queue_url
}

output "delivery_dead_letter_queue_url" {
  description = "Queue a dead delivery is copied to."
  value       = var.actions == null ? null : module.actions[0].delivery_dead_letter_queue_url
}

output "stream_failure_queue_url" {
  description = "Queue holding stream batches the dispatcher never turned into deliveries."
  value       = var.actions == null ? null : module.actions[0].stream_failure_queue_url
}

output "outbound_queue_url" {
  description = "Queue for signed deliveries that did not come from a match."
  value       = var.actions == null ? null : module.actions[0].outbound_queue_url
}

output "api_endpoint" {
  description = "Base URL of the HTTP API, without /v1, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].api_endpoint
}

output "api_id" {
  description = "HTTP API id, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].api_id
}

output "session_secret_parameter" {
  description = "SSM parameter name holding the session signing secret, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].session_secret_parameter
}

output "api_role_arn" {
  description = "IAM role of the API's route Lambda, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].api_role_arn
}

output "site_bucket" {
  description = "S3 bucket the dashboard's static export is synced to, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].site_bucket
}

output "distribution_id" {
  description = "CloudFront distribution serving the dashboard and the API, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].distribution_id
}

output "site_url" {
  description = "Where the dashboard is served, or null when the API is not deployed."
  value       = var.api == null ? null : module.api[0].site_url
}

output "permissions_boundary_arns" {
  description = "The permissions boundary on one role of each part, so a caller can check the value reached the roles and not only this module. A part that is switched off is null."
  value = {
    monitor = aws_iam_role.monitor.permissions_boundary
    actions = var.actions == null ? null : module.actions[0].permissions_boundary_arn
    api     = var.api == null ? null : module.api[0].permissions_boundary_arn
  }
}
