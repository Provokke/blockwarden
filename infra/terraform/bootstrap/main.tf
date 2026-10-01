# Applied once, by hand, with administrator credentials. It creates the bucket every other root keeps its state
# in, so its own state starts out local; the README's Deploying section says how to keep it or move it.
terraform {
  required_version = ">= 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "blockwarden"
      environment = "bootstrap"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  state_bucket     = coalesce(var.state_bucket_name, "blockwarden-tfstate-${local.account_id}-${var.region}")
  state_bucket_arn = "arn:${local.partition}:s3:::${local.state_bucket}"

  # the audience configure-aws-credentials asks GitHub for by default
  github_audience   = "sts.amazonaws.com"
  oidc_provider_arn = var.existing_oidc_provider_arn != null ? var.existing_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}
