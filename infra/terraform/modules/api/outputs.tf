output "api_endpoint" {
  description = "Base URL of the HTTP API, without /v1."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_id" {
  description = "HTTP API id, for the CloudFront origin and the 5xx alarm's dimension."
  value       = aws_apigatewayv2_api.api.id
}

output "session_secret_parameter" {
  description = "SSM SecureString parameter name holding the session signing secret. Each function reads it once, at cold start."
  value       = aws_ssm_parameter.session_secret.name
}

output "api_role_arn" {
  description = "IAM role of the route Lambda."
  value       = aws_iam_role.api.arn
}
