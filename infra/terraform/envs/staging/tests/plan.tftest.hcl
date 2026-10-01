# Plans the staging stack against mock providers, as envs/demo/tests does for the demo: nothing reaches AWS.
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

mock_provider "archive" {}

mock_provider "random" {}

variables {
  allowed_wallets = ["0x52908400098527886E0F7030069857D2E4169EE7"]
  boundary        = "arn:aws:iam::123456789012:policy/blockwarden-staging-boundary"
}

run "the_stack_plans_from_empty_under_its_own_names" {
  command = plan

  assert {
    condition     = output.table_name == "blockwarden-staging"
    error_message = "staging's table is blockwarden-staging"
  }

  assert {
    condition     = alltrue([for name in values(output.monitor_function_names) : startswith(name, "blockwarden-staging-")])
    error_message = "every staging function name starts blockwarden-staging-"
  }

  assert {
    condition     = output.alarm_topic_arn == "arn:aws:sns:ap-southeast-2:123456789012:blockwarden-staging-alarms"
    error_message = "staging has its own alarm topic"
  }

  assert {
    condition     = output.session_secret_parameter == "/blockwarden-staging/api/session-secret"
    error_message = "staging's session secret is under /blockwarden-staging/"
  }

  # the apply role holds CloudFront, API Gateway, KMS, ACM and event source mappings to their stack by this tag, and
  # a mock provider applies no default_tags, so the provider block is read as text
  assert {
    condition     = can(regex("default_tags \\{\\s*tags = \\{[^}]*environment\\s*=\\s*\"staging\"", file("${path.root}/main.tf")))
    error_message = "the aws provider's default_tags must set environment = \"staging\""
  }
}

run "the_boundary_reaches_every_module" {
  command = plan

  assert {
    condition     = module.blockwarden.permissions_boundary_arns.monitor == var.boundary
    error_message = "the stack must hand the staging boundary to modules/blockwarden"
  }

  assert {
    condition     = module.blockwarden.permissions_boundary_arns.actions == var.boundary
    error_message = "modules/blockwarden must hand the boundary to modules/actions"
  }

  assert {
    condition     = module.blockwarden.permissions_boundary_arns.api == var.boundary
    error_message = "modules/blockwarden must hand the boundary to modules/api"
  }

  assert {
    condition     = module.relayer.permissions_boundary_arn == var.boundary
    error_message = "the stack must hand the staging boundary to modules/relayer"
  }
}
