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

output "site_bucket" {
  description = "S3 bucket the dashboard's static export is synced to."
  value       = aws_s3_bucket.site.bucket
}

output "distribution_id" {
  description = "CloudFront distribution serving the dashboard and /v1/*, for invalidating after a sync."
  value       = aws_cloudfront_distribution.site.id
}

output "site_url" {
  description = "Where the dashboard is served: site_origin, or the distribution's own name when that is null. A sign-in is accepted from this origin only."
  value       = local.site_origin
}
