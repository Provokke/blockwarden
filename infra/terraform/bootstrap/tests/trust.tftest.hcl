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
            "repo:Provokke@70989453/blockwarden@1371434855:pull_request",
          ]
        }
      }
    }
    error_message = "the plan role must trust exactly the pull_request subject of Provokke/blockwarden, in its immutable form, with the sts.amazonaws.com audience"
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
    condition = toset(flatten([
      for s in jsondecode(aws_iam_role_policy.plan_state.policy).Statement : s.Action
    ])) == toset(["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"])
    error_message = "the plan role's state access is exactly list, get, put and delete"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_role_policy.plan_state.policy).Statement : [
        for r in s.Resource : startswith(r, "arn:aws:s3:::blockwarden-tfstate-123456789012-ap-southeast-2")
      ]
    ]))
    error_message = "the plan role's state access names the state bucket and nothing else"
  }

  # an exact set, so a new read action is a decision made here and not a quiet addition
  assert {
    condition = toset(flatten([
      for s in jsondecode(aws_iam_policy.read.policy).Statement : s.Action
      ])) == toset([
      "acm:DescribeCertificate", "acm:ListTagsForCertificate", "apigateway:GET",
      "cloudfront:DescribeFunction", "cloudfront:GetCachePolicy", "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig", "cloudfront:GetFunction", "cloudfront:GetInvalidation",
      "cloudfront:GetOriginAccessControl", "cloudfront:GetOriginRequestPolicy",
      "cloudfront:GetResponseHeadersPolicy", "cloudfront:ListCachePolicies",
      "cloudfront:ListOriginRequestPolicies", "cloudfront:ListTagsForResource", "cloudwatch:DescribeAlarms",
      "cloudwatch:ListTagsForResource", "dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTable",
      "dynamodb:DescribeTimeToLive", "dynamodb:GetItem", "dynamodb:ListTagsOfResource", "iam:GetRole",
      "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
      "iam:ListRolePolicies", "iam:ListRoleTags", "kms:DescribeKey", "kms:GetKeyPolicy",
      "kms:GetKeyRotationStatus", "kms:ListAliases", "kms:ListResourceTags", "lambda:GetEventSourceMapping",
      "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConcurrency",
      "lambda:GetFunctionConfiguration", "lambda:GetFunctionEventInvokeConfig", "lambda:GetPolicy",
      "lambda:ListTags", "lambda:ListVersionsByFunction", "logs:DescribeLogGroups",
      "logs:ListTagsForResource", "s3:GetAccelerateConfiguration", "s3:GetBucketAcl", "s3:GetBucketCORS",
      "s3:GetBucketLogging", "s3:GetBucketObjectLockConfiguration", "s3:GetBucketOwnershipControls",
      "s3:GetBucketPolicy", "s3:GetBucketPublicAccessBlock", "s3:GetBucketRequestPayment",
      "s3:GetBucketTagging", "s3:GetBucketVersioning", "s3:GetBucketWebsite",
      "s3:GetEncryptionConfiguration", "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration",
      "s3:ListBucket", "scheduler:GetSchedule", "sns:GetSubscriptionAttributes", "sns:GetTopicAttributes",
      "sns:ListSubscriptionsByTopic", "sns:ListTagsForResource", "sqs:GetQueueAttributes",
      "sqs:ListQueueTags", "ssm:DescribeParameters", "ssm:GetParameter", "ssm:ListTagsForResource",
    ])
    error_message = "the read policy grants exactly the listed actions"
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
        for r in s.Resource : can(regex("parameter/blockwarden-(staging|demo)/(api/session-secret|relayer/api-keys/[*])$", r))
      ] if contains(s.Action, "ssm:GetParameter")
    ]))
    error_message = "ssm:GetParameter is for the parameters Terraform writes, never the owner's RPC URLs or webhook secret"
  }

  assert {
    condition     = !strcontains(aws_iam_policy.read.policy, "kms:Decrypt")
    error_message = "the read policy must not grant kms:Decrypt"
  }

  assert {
    condition = alltrue(flatten([
      for s in jsondecode(aws_iam_policy.read.policy).Statement : [
        for a in s.Action : !can(regex("^(secretsmanager:|ssm:GetParameter.|s3:GetObject|logs:Get)", a))
      ]
    ]))
    error_message = "the read policy must not read secrets, parameter paths, objects or log events"
  }
}

run "reads_only_the_items_terraform_writes" {
  command = apply

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_policy.read.policy).Statement :
      s.Condition == { "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["RULE#*", "SIGNER#*", "APIKEY#*"] } }
      if contains(s.Action, "dynamodb:GetItem")
    ])
    error_message = "dynamodb:GetItem is limited to the RULE#, SIGNER# and APIKEY# items Terraform writes"
  }

  assert {
    condition = length([
      for s in jsondecode(aws_iam_policy.read.policy).Statement : s
      if contains(s.Action, "dynamodb:GetItem")
    ]) == 1
    error_message = "exactly one statement grants GetItem"
  }
}

run "adopts_an_existing_provider" {
  command = apply

  # an account other than the mock's default, so a variable that is ignored cannot pass
  override_data {
    target = data.aws_caller_identity.current
    values = { account_id = "210987654321" }
  }

  variables {
    existing_oidc_provider_arn = "arn:aws:iam::210987654321:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "an adopted provider must not be created again"
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Principal.Federated == "arn:aws:iam::210987654321:oidc-provider/token.actions.githubusercontent.com"
    error_message = "the roles must trust the adopted provider"
  }
}

run "refuses_a_provider_from_another_account" {
  command = plan

  variables {
    existing_oidc_provider_arn = "arn:aws:iam::999999999999:oidc-provider/token.actions.githubusercontent.com"
  }

  expect_failures = [aws_iam_role.plan]
}

run "refuses_a_wildcard_repository" {
  command = plan

  variables {
    github_repository = "Provokke/*"
  }

  expect_failures = [var.github_repository]
}

run "refuses_a_wildcard_sub_prefix" {
  command = plan

  variables {
    github_sub_prefix = "repo:Provokke@70989453/*"
  }

  expect_failures = [var.github_sub_prefix]
}

run "refuses_the_name_only_sub_prefix" {
  command = plan

  variables {
    github_sub_prefix = "repo:Provokke/blockwarden"
  }

  expect_failures = [var.github_sub_prefix]
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
