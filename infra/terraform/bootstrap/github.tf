# An account holds one provider per URL. One that already has a GitHub provider passes its ARN in
# existing_oidc_provider_arn, and this one is not created.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.existing_oidc_provider_arn == null ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = [local.github_audience]
}

locals {
  # The sub claims GitHub writes for a pull request, for a push to a branch, and for a job that names an
  # environment. A job that names an environment gets the environment form whatever triggered it, which is why the
  # plan jobs name none. Pull requests from forks get no token at all: GitHub turns id-token: write into read for
  # them, so the pull_request subject is reachable only from a branch in this repository.
  role_subjects = {
    plan = [
      "repo:${var.github_repository}:pull_request",
      "repo:${var.github_repository}:ref:refs/heads/main",
    ]
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
