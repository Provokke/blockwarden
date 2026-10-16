# modules/api's optional custom domain, planned against mock providers. The us-east-1 mock knows a certificate's
# ARN at plan and the default one does not, so a certificate requested through the wrong provider fails the
# region assertion below.
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

  override_during = plan
  mock_resource "aws_acm_certificate" {
    defaults = { arn = "arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000" }
  }
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
}

run "without_a_domain_nothing_changes" {
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

  assert {
    condition     = length(aws_acm_certificate.site) == 0 && length(aws_acm_certificate_validation.site) == 0
    error_message = "no certificate exists without a domain"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == null
    error_message = "the distribution has no alias without a domain"
  }

  assert {
    condition = (
      aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate &&
      aws_cloudfront_distribution.site.viewer_certificate[0].acm_certificate_arn == null &&
      aws_cloudfront_distribution.site.viewer_certificate[0].ssl_support_method == null &&
      aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == null
    )
    error_message = "without a domain the distribution keeps the default certificate and sets nothing else"
  }

  assert {
    condition     = output.domain_records == null
    error_message = "there are no records to create without a domain"
  }
}

run "a_domain_gets_a_us_east_1_certificate_and_the_alias" {
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

  variables {
    domain = { host_name = "demo.example.com" }
  }

  assert {
    condition     = length(aws_acm_certificate.site) == 1 && startswith(aws_acm_certificate.site[0].arn, "arn:aws:acm:us-east-1:")
    error_message = "the certificate must be requested through the us-east-1 provider"
  }

  assert {
    condition     = aws_acm_certificate.site[0].domain_name == "demo.example.com" && aws_acm_certificate.site[0].validation_method == "DNS"
    error_message = "the certificate is for the host name, validated by DNS"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.aliases == toset(["demo.example.com"])
    error_message = "the distribution answers to the host name"
  }

  assert {
    condition = (
      !aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate &&
      aws_cloudfront_distribution.site.viewer_certificate[0].ssl_support_method == "sni-only" &&
      aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    )
    error_message = "with a domain the distribution uses SNI and TLS 1.2 at least"
  }

  assert {
    condition     = output.site_url == "https://demo.example.com"
    error_message = "site_origin follows the domain"
  }

  assert {
    condition = (
      aws_lambda_function.api["api"].environment[0].variables.SITE_ORIGIN == "https://demo.example.com" &&
      aws_lambda_function.api["api"].environment[0].variables.SIWE_DOMAIN == "demo.example.com"
    )
    error_message = "the API accepts sign-ins for the domain"
  }

  assert {
    condition     = output.domain_records.cname.name == "demo.example.com" && output.domain_records.cname.type == "CNAME"
    error_message = "the records include the CNAME for the host name"
  }
}

run "an_issued_certificate_is_used_as_given" {
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

  variables {
    domain = {
      host_name          = "demo.example.com"
      create_certificate = false
      certificate_arn    = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
    }
  }

  assert {
    condition     = length(aws_acm_certificate.site) == 0
    error_message = "no certificate is requested when one is given"
  }

  assert {
    condition     = aws_cloudfront_distribution.site.viewer_certificate[0].acm_certificate_arn == "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
    error_message = "the given certificate is the distribution's"
  }
}

run "a_certificate_arn_beside_create_certificate_is_refused" {
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

  variables {
    domain = {
      host_name       = "demo.example.com"
      certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/11111111-1111-1111-1111-111111111111"
    }
  }

  expect_failures = [var.domain]
}

run "a_site_origin_for_another_host_is_refused" {
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

  variables {
    domain      = { host_name = "demo.example.com" }
    site_origin = "https://other.example.com"
  }

  expect_failures = [var.domain]
}

run "the_full_stack_repeats_the_domain_checks" {
  command = plan

  module {
    source = "../../modules/blockwarden"
  }

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    archive       = archive
    random        = random
  }

  variables {
    monitor_source_dir = "/nonexistent"
    chains = {
      base = { chain_id = 8453, rpc_urls_parameter = "/blockwarden-demo/rpc/base", lag_alarm_blocks = 300 }
    }
    actions = { source_dir = "/nonexistent" }
    api = {
      source_dir      = "/nonexistent"
      allowed_wallets = ["0x52908400098527886E0F7030069857D2E4169EE7"]
      domain          = { host_name = "Demo.Example.com" }
    }
  }

  expect_failures = [var.api]
}
