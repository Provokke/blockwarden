# The mock would give every policy the same ARN, which would let a role name the other stack's boundary unnoticed,
# so each boundary gets the ARN the stack's own root computes for it.
override_resource {
  target = aws_iam_policy.boundary["staging"]
  values = { arn = "arn:aws:iam::123456789012:policy/blockwarden-staging-boundary" }
}

override_resource {
  target = aws_iam_policy.boundary["demo"]
  values = { arn = "arn:aws:iam::123456789012:policy/blockwarden-demo-boundary" }
}

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
    defaults = { arn = "arn:aws:iam::123456789012:policy/mock" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/mock" }
  }
}

run "apply_roles_trust_only_their_environment" {
  command = apply

  assert {
    condition = {
      for env, role in aws_iam_role.apply : env => jsondecode(role.assume_role_policy).Statement
      } == {
      for env in ["staging", "demo"] : env => [{
        Sid       = "GitHubActions"
        Effect    = "Allow"
        Action    = "sts:AssumeRoleWithWebIdentity"
        Principal = { Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
            "token.actions.githubusercontent.com:sub" = ["repo:Provokke@70989453/blockwarden@1371434855:environment:${env}"]
          }
        }
      }]
    }
    error_message = "each apply role must trust exactly repo:Provokke@70989453/blockwarden@1371434855:environment:<its env>, with the sts.amazonaws.com audience"
  }

  assert {
    condition     = aws_iam_role.apply["staging"].name == "blockwarden-staging-apply" && aws_iam_role.apply["demo"].name == "blockwarden-demo-apply"
    error_message = "the apply roles are blockwarden-staging-apply and blockwarden-demo-apply"
  }
}

run "apply_roles_touch_only_their_own_state" {
  command = apply

  assert {
    condition = alltrue(flatten([
      for env, p in aws_iam_role_policy.apply : [
        for s in jsondecode(p.policy).Statement : [
          for r in s.Resource : startswith(r, "arn:aws:s3:::blockwarden-tfstate-123456789012-ap-southeast-2/${env}/terraform.tfstate")
          ] if length([for a in s.Action : a if contains(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], a)]) > 0 && anytrue([
            for r in s.Resource : startswith(r, "arn:aws:s3:::blockwarden-tfstate-")
        ])
      ]
    ]))
    error_message = "an apply role reads and writes only <its env>/terraform.tfstate and its lock file"
  }
}

run "each_stack_names_only_itself" {
  command = apply

  assert {
    condition     = !strcontains(aws_iam_role_policy.apply["staging"].policy, "blockwarden-demo") && !strcontains(aws_iam_role_policy.apply["demo"].policy, "blockwarden-staging")
    error_message = "an apply policy must never name the other stack"
  }

  assert {
    condition     = !strcontains(aws_iam_policy.boundary["staging"].policy, "blockwarden-demo") && !strcontains(aws_iam_policy.boundary["demo"].policy, "blockwarden-staging")
    error_message = "a boundary must never name the other stack"
  }

  assert {
    condition = alltrue(flatten([
      for env in ["staging", "demo"] : [
        for s in concat(jsondecode(aws_iam_role_policy.apply[env].policy).Statement, jsondecode(aws_iam_policy.boundary[env].policy).Statement) : [
          for r in s.Resource : strcontains(r, "blockwarden-${env}")
          if strcontains(r, "blockwarden-") && !startswith(r, "arn:aws:s3:::blockwarden-tfstate-")
        ]
      ]
    ]))
    error_message = "every resource that names blockwarden must name this stack's prefix, never blockwarden-*"
  }
}

run "roles_are_created_only_inside_the_boundary" {
  command = apply

  assert {
    condition     = aws_iam_policy.boundary["staging"].name == "blockwarden-staging-boundary" && aws_iam_policy.boundary["demo"].name == "blockwarden-demo-boundary"
    error_message = "the boundaries are named blockwarden-<env>-boundary, the ARN each stack's root computes"
  }

  assert {
    condition = alltrue(flatten([
      for env, p in aws_iam_role_policy.apply : [
        for s in jsondecode(p.policy).Statement :
        try(s.Condition.StringEquals["iam:PermissionsBoundary"], "") == aws_iam_policy.boundary[env].arn
        if s.Effect == "Allow" && length(setintersection(s.Action, ["iam:CreateRole", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary"])) > 0
      ]
    ]))
    error_message = "every grant that creates a role or changes its policy must require the stack's boundary"
  }

  assert {
    condition = alltrue(flatten([
      for env, p in aws_iam_role_policy.apply : [
        anytrue([
          for s in jsondecode(p.policy).Statement :
          s.Effect == "Deny" && contains(s.Action, "iam:*") && contains(s.Resource, "arn:aws:iam::123456789012:role/blockwarden-${env}-apply")
        ])
      ]
    ]))
    error_message = "an apply role must deny itself every IAM action, since its name matches its own prefix"
  }

  assert {
    condition = alltrue([
      for p in aws_iam_role_policy.apply : !anytrue([
        for s in jsondecode(p.policy).Statement :
        s.Effect == "Allow" && anytrue([for a in s.Action : a == "*" || endswith(a, ":*")])
      ])
    ])
    error_message = "no apply statement may allow a whole service"
  }

  assert {
    condition = alltrue([
      for p in aws_iam_policy.boundary : !anytrue([
        for s in jsondecode(p.policy).Statement : anytrue([for a in s.Action : startswith(a, "iam:") || a == "*" || endswith(a, ":*")])
      ])
    ])
    error_message = "a boundary must grant no IAM action and no whole service"
  }
}

run "policies_fit_their_size_limits" {
  command = apply

  assert {
    condition     = alltrue([for p in aws_iam_role_policy.apply : length(p.policy) <= 10240])
    error_message = "a role's inline policies hold at most 10,240 characters"
  }

  assert {
    condition     = alltrue([for p in aws_iam_policy.boundary : length(p.policy) <= 6144])
    error_message = "a managed policy holds at most 6,144 characters"
  }
}
