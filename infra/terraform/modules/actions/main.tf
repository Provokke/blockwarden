terraform {
  required_version = ">= 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.8"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region
  partition  = data.aws_partition.current.partition

  functions = {
    dispatcher = { timeout = 60, memory = 256 }
    sender     = { timeout = 30, memory = 256 }
  }

  secret_parameter_arns = [
    for name in distinct(concat(
      var.webhook_secret_parameter == null ? [] : [var.webhook_secret_parameter],
      var.telegram_token_parameter == null ? [] : [var.telegram_token_parameter],
      var.relayer_api_key_parameter == null ? [] : [var.relayer_api_key_parameter],
      # a relayer signer names its own webhook secret, and lookup.ts hands it to the sender per delivery
      var.signer_webhook_secret_parameters,
    )) : "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${name}"
  ]

  # a caller may only name a parameter under one of these, and the sender may only read under one of these.
  # The trailing slash is put back deliberately: the code compares against the level separator, so "/bw/shops"
  # means /bw/shops/*, and "parameter/bw/shops*" would have granted /bw/shopsEvil as well.
  outbound_secret_arns = [
    for prefix in var.outbound_secret_prefixes :
    "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(prefix, "/")}/*"
  ]

  # the same, for the parameters a rule's own webhook action may name. A separate list, so granting a rule's
  # secret does not also widen what an outbound caller may name.
  rule_secret_arns = [
    for prefix in var.rule_secret_prefixes :
    "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${trimsuffix(prefix, "/")}/*"
  ]

  all_secret_arns = concat(local.secret_parameter_arns, local.outbound_secret_arns, local.rule_secret_arns)

  # anchored, as the config's own regex is: an unanchored ":sqs:" also matches a queue name that contains it
  target_queue_arns    = [for arn in var.allowed_target_arns : arn if can(regex("^arn:aws[a-z-]*:sqs:", arn))]
  target_function_arns = [for arn in var.allowed_target_arns : arn if can(regex("^arn:aws[a-z-]*:lambda:", arn))]
}
