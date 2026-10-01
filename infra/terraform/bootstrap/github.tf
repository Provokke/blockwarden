# An account holds one provider per URL. One that already has a GitHub provider passes its ARN in
# existing_oidc_provider_arn, and this one is not created.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.existing_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = [local.github_audience]
}

locals {
  # The sub claim GitHub writes for a pull request. This repository issues the immutable subject format, which names
  # the owner and the repository by id as well as by name, so a renamed or re-created repository cannot claim it.
  # Pull requests from forks get no token at all: GitHub turns id-token: write into read for them, so the
  # pull_request subject is reachable only from a branch in this repository. The assumption that remains is that no
  # pull_request_target or workflow_run workflow requests id-token: write, since those run with the base
  # repository's context for a trigger an outsider can cause.
  role_subjects = {
    plan = ["${var.github_sub_prefix}:pull_request"]
  }

  # StringEquals on both claims, never StringLike: a sub list is a set of exact strings
  trust_policies = { for role, subjects in local.role_subjects : role => {
    Version = "2012-10-17"
    Statement = [{
      Sid       = "GitHubActions"
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_provider_arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = local.github_audience
          "token.actions.githubusercontent.com:sub" = subjects
        }
      }
    }]
  } }
}
