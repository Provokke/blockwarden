# modules/api's security headers, planned against mock providers. The two functions' ARNs and the managed policy's
# id are set at plan, so the assertions can tell what each cache behaviour runs. 67f7725c-... is the id AWS
# documents for Managed-SecurityHeadersPolicy; the real plan looks it up by name.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_region" {
    defaults = { region = "ap-southeast-2" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}

mock_provider "aws" {
  alias = "us_east_1"
}

mock_provider "archive" {}

mock_provider "random" {}

variables {
  name           = "blockwarden-demo"
  api_source_dir = "/nonexistent"
  table          = { name = "blockwarden-demo", arn = "arn:aws:dynamodb:ap-southeast-2:123456789012:table/blockwarden-demo" }
  queues = {
    delivery       = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/d", arn = "arn:aws:sqs:ap-southeast-2:123456789012:d" }
    dead_letter    = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/l", arn = "arn:aws:sqs:ap-southeast-2:123456789012:l" }
    stream_failure = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/s", arn = "arn:aws:sqs:ap-southeast-2:123456789012:s" }
  }
  chains          = { base = { chain_id = 8453, rpc_urls_parameter = "/blockwarden-demo/rpc/base" } }
  allowed_wallets = ["0x52908400098527886E0F7030069857D2E4169EE7"]
  alarm_topic_arn = "arn:aws:sns:ap-southeast-2:123456789012:blockwarden-demo-alarms"
  site_script_hashes = [
    "sha256-lyTN6OpbNBmA84UPafLhT+mqPgMl6Zh8SXt5ZSZ/s1g=",
    "sha256-AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=",
  ]

  # written out by hand, as apps/dashboard/test/security-headers.test.ts writes it
  expected_policy = "default-src 'self'; script-src 'self' 'sha256-lyTN6OpbNBmA84UPafLhT+mqPgMl6Zh8SXt5ZSZ/s1g=' 'sha256-AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI='; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
}

run "the_security_headers_are_a_named_function_on_both_behaviours" {
  command = plan

  module {
    source = "../../modules/api"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    archive       = archive
    random        = random
  }

  override_resource {
    target          = aws_cloudfront_function.site_rewrite
    override_during = plan
    values          = { arn = "arn:aws:cloudfront::123456789012:function/blockwarden-demo-site-rewrite" }
  }

  override_data {
    target          = data.aws_cloudfront_response_headers_policy.security_headers
    override_during = plan
    values          = { id = "67f7725c-6f97-4210-82d7-5512b31e9d03" }
  }

  override_resource {
    target          = aws_cloudfront_function.security_headers
    override_during = plan
    values          = { arn = "arn:aws:cloudfront::123456789012:function/blockwarden-demo-security-headers" }
  }

  assert {
    condition = (
      aws_cloudfront_function.security_headers.name == "blockwarden-demo-security-headers" &&
      aws_cloudfront_function.security_headers.runtime == "cloudfront-js-2.0" &&
      aws_cloudfront_function.security_headers.publish
    )
    error_message = "the headers function is blockwarden-<env>-security-headers, published, on cloudfront-js-2.0, so an apply role's function grant covers it"
  }

  assert {
    condition     = aws_cloudfront_function.security_headers.code == templatefile("../../modules/api/security-headers.js.tftpl", { csp = jsonencode(var.expected_policy) })
    error_message = "the function's code must be the template with exactly this build's policy"
  }

  assert {
    condition = toset([
      for f in aws_cloudfront_distribution.site.default_cache_behavior[0].function_association : "${f.event_type} ${f.function_arn}"
      ]) == toset([
      "viewer-request arn:aws:cloudfront::123456789012:function/blockwarden-demo-site-rewrite",
      "viewer-response arn:aws:cloudfront::123456789012:function/blockwarden-demo-security-headers",
    ])
    error_message = "the dashboard's paths rewrite on the request and get the security headers on the response"
  }

  assert {
    condition = toset([
      for f in aws_cloudfront_distribution.site.ordered_cache_behavior[0].function_association : "${f.event_type} ${f.function_arn}"
      ]) == toset([
      "viewer-response arn:aws:cloudfront::123456789012:function/blockwarden-demo-security-headers",
    ]) && aws_cloudfront_distribution.site.ordered_cache_behavior[0].path_pattern == "/v1/*"
    error_message = "/v1/* gets the same security headers, and no rewrite"
  }

  assert {
    condition = (
      data.aws_cloudfront_response_headers_policy.security_headers.name == "Managed-SecurityHeadersPolicy" &&
      aws_cloudfront_distribution.site.default_cache_behavior[0].response_headers_policy_id == "67f7725c-6f97-4210-82d7-5512b31e9d03" &&
      aws_cloudfront_distribution.site.ordered_cache_behavior[0].response_headers_policy_id == "67f7725c-6f97-4210-82d7-5512b31e9d03"
    )
    error_message = "both behaviours carry AWS's managed security headers policy, which no role in the account can change, for the responses the function never sees"
  }
}
