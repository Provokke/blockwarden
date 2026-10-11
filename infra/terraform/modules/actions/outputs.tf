output "delivery_queue_url" {
  description = "Queue the dispatcher puts delivery pointers on."
  value       = aws_sqs_queue.deliveries.url
}

output "delivery_dead_letter_queue_url" {
  description = "Queue a dead delivery is copied to. Redrive with the delivery:redrive script."
  value       = aws_sqs_queue.dead_letter.url
}

output "stream_failure_queue_url" {
  description = "Queue holding stream batches Lambda discarded. Nothing redrives these; the records have to come back out of the stream."
  value       = aws_sqs_queue.stream_failures.url
}

output "outbound_queue_url" {
  description = "Queue that accepts signed deliveries which did not come from a match, or null when it is switched off."
  value       = var.outbound_queue ? aws_sqs_queue.outbound[0].url : null
}

output "outbound_queue_arn" {
  description = "ARN of that queue, for a caller's own IAM policy."
  value       = var.outbound_queue ? aws_sqs_queue.outbound[0].arn : null
}

output "function_names" {
  description = "The two Lambda function names."
  value       = { for key, f in aws_lambda_function.actions : key => f.function_name }
}
