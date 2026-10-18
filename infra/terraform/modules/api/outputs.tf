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

output "domain_records" {
  description = "With domain set, the DNS records to create where the domain is hosted: the certificate's validation records when this module requested it, and the CNAME pointing the host name at the distribution. Null without a domain."
  value = var.domain == null ? null : {
    validation = flatten([for c in aws_acm_certificate.site : [
      for o in c.domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }
    ]])
    cname = { name = var.domain.host_name, type = "CNAME", value = aws_cloudfront_distribution.site.domain_name }
  }
}

output "site_url" {
  description = "Where the dashboard is served: site_origin, or the distribution's own name when that is null. A sign-in is accepted from this origin only."
  value       = local.site_origin
}

output "permissions_boundary_arn" {
  description = "The permissions boundary on the api role, so a caller can check the value reached the role and not only this module."
  value       = aws_iam_role.api.permissions_boundary
}
