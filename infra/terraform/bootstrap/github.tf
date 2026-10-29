# An account only holds one provider per URL. If one already exists, pass its ARN in
# existing_oidc_provider_arn
# and this one isn't created.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.existing_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = [local.github_audience]
}

locals {
  # The sub claim GitHub writes for a pull request. Uses the immutable subject format (owner and
  # repo by id as well as
  # name), so a renamed or re-created repo can't claim it. Forks get no token: GitHub downgrades
  # id-token: write to read,
  # so this subject only comes from a branch in this repo. Remaining assumption: no
  # pull_request_target or workflow_run
  # workflow requests id-token: write, since those run in the base repo's context on triggers an
  # outsider can cause.
  role_subjects = merge(
    {
      plan = ["${var.github_sub_prefix}:pull_request"]
    },
    { for env in local.environments : "${env}-apply" => ["${var.github_sub_prefix}:environment:${env}"] },
  )

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
