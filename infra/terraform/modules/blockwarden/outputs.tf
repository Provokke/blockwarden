output "table_name" {
  description = "DynamoDB table name."
  value       = aws_dynamodb_table.main.name
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
  value       = aws_sns_topic.alarms.arn
}
