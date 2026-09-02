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
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
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

  table_name = var.table == null ? aws_dynamodb_table.relayer[0].name : var.table.name
  table_arn  = var.table == null ? aws_dynamodb_table.relayer[0].arn : var.table.arn

  alarm_topic_arn = var.alarm_topic_arn == null ? aws_sns_topic.alarms[0].arn : var.alarm_topic_arn

  # the shape src/config.ts parses from CHAINS
  chains_env = jsonencode([for c in var.chains : {
    chainId           = c.chain_id
    rpcUrlsParameter  = c.rpc_urls_parameter
    confirmations     = c.confirmations
    stuckAfterSeconds = c.stuck_after_seconds
  }])

  rpc_parameter_arns = [for c in var.chains : "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${c.rpc_urls_parameter}"]
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}
