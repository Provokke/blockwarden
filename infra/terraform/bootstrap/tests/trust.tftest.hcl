# Renders the bootstrap with a mock AWS provider, so nothing here reaches AWS: an apply against mock_provider
# only computes values. The trust policies are built with jsonencode for this reason; a data source's json would
# be a mock string here.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = { arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::123456789012:policy/blockwarden-read" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
}

run "plan_role_trusts_exactly_this_repository" {
  command = apply

  assert {
    condition     = length(jsondecode(aws_iam_role.plan.assume_role_policy).Statement) == 1
    error_message = "the plan role's trust policy must have exactly one statement"
  }

  assert {
    condition = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0] == {
      Sid       = "GitHubActions"
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = [
            "repo:Provokke/blockwarden:pull_request",
            "repo:Provokke/blockwarden:ref:refs/heads/main",
          ]
        }
      }
    }
    error_message = "the plan role must trust exactly the pull_request and main subjects of Provokke/blockwarden, with the sts.amazonaws.com audience"
  }

  assert {
    condition = alltrue([
      for sub in jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] :
      !strcontains(split(":", sub)[1], "*")
    ])
    error_message = "no sub may carry a wildcard in its repository part"
  }

  assert {
    condition     = !strcontains(aws_iam_role.plan.assume_role_policy, "StringLike")
    error_message = "a trust policy must not match with StringLike"
  }
}

run "plan_role_writes_only_lock_files" {
  command = apply

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.plan_state.policy).Statement : [
        for r in s.Resource : endswith(r, ".tflock")
      ] if length(setintersection(s.Action, ["s3:PutObject", "s3:DeleteObject"])) > 0
    ]))
    error_message = "the plan role may write and delete lock files only"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_iam_role_policy.plan_state.policy).Statement : s
      if length(setintersection(s.Action, ["s3:PutObject", "s3:DeleteObject"])) > 0
    ]) == 1
    error_message = "exactly one statement grants a write"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.read.policy).Statement :
      alltrue([for a in s.Action : can(regex(":(Get|List|Describe)[A-Za-z]*$|^apigateway:GET$", a))])
    ])
    error_message = "the read policy may only get, list and describe"
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.read.policy).Statement : s.Effect == "Allow"
    ])
    error_message = "every read statement allows"
  }
}

run "reads_no_owner_secret" {
  command = apply

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.read.policy).Statement : [
        for r in s.Resource : can(regex("parameter/blockwarden-[*]/(api/session-secret|relayer/api-keys/[*])$", r))
      ] if contains(s.Action, "ssm:GetParameter")
    ]))
    error_message = "ssm:GetParameter is for the parameters Terraform writes, never the owner's RPC URLs or webhook secret"
  }

  assert {
    condition     = !strcontains(aws_iam_policy.read.policy, "kms:Decrypt")
    error_message = "the read policy must not grant kms:Decrypt"
  }
}

run "adopts_an_existing_provider" {
  command = apply

  variables {
    existing_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "an adopted provider must not be created again"
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    error_message = "the roles must trust the adopted provider"
  }
}

run "refuses_a_wildcard_repository" {
  command = plan

  variables {
    github_repository = "Provokke/*"
  }

  expect_failures = [var.github_repository]
}

run "names_the_state_bucket_from_the_account_and_region" {
  command = apply

  assert {
    condition     = aws_s3_bucket.state.bucket == "blockwarden-tfstate-123456789012-ap-southeast-2"
    error_message = "the default bucket name is blockwarden-tfstate-<account id>-<region>"
  }

  assert {
    condition     = length(jsondecode(aws_iam_policy.read.policy)) > 0 && length(aws_iam_policy.read.policy) <= 6144
    error_message = "a managed policy holds at most 6,144 characters"
  }
}
