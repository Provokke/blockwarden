output "api_url" {
  description = "Base URL for @blockwarden/relayer-client, without /v1."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "table_name" {
  description = "The table the relayer writes to."
  value       = local.table_name
}

output "queue_url" {
  description = "The FIFO queue the signer consumes."
  value       = aws_sqs_queue.txs.url
}

output "dead_letter_queue_url" {
  description = "Signer messages that failed five times."
  value       = aws_sqs_queue.dead_letter.url
}

# Terraform has no keccak256, so it cannot derive a signer's address from its public key.
# GET /v1/relayer/signers (listSigners in the client) returns each address.
output "signer_key_arns" {
  description = "KMS key ARN per signer id."
  value       = { for id, k in aws_kms_key.signer : id => k.arn }
}

output "api_key_parameters" {
  description = "SSM SecureString parameter name holding each API key created here."
  value       = { for label, p in aws_ssm_parameter.api_key : label => p.name }
}

output "function_names" {
  description = "Lambda function name for api, signer and sweeper."
  value       = { for key, f in aws_lambda_function.relayer : key => f.function_name }
}

output "alarm_topic_arn" {
  description = "SNS topic that receives the relayer's alarms."
  value       = local.alarm_topic_arn
}
