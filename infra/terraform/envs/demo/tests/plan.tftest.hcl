# Plans the demo stack, and each module on its own, against mock providers: nothing here reaches AWS, and no
# Lambda bundle has to be built, because archive is mocked too. A mock leaves every computed attribute unknown at
# plan, as a first real plan against an empty account does.
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
  boundary        = "arn:aws:iam::123456789012:policy/blockwarden-demo-boundary"
}

run "the_stack_plans_from_empty" {
  command = plan

  assert {
    condition     = output.alarm_topic_arn == "arn:aws:sns:ap-southeast-2:123456789012:blockwarden-demo-alarms"
    error_message = "the alarm topic's ARN must be known at plan, or the relayer cannot count its own topic"
  }

  # the runs below plan each module as a root, so they cannot see a pass-through dropped between the stack and a
  # child; these read the boundary off a role in each child, as that child received it
  assert {
    condition     = module.blockwarden.permissions_boundary_arns.monitor == var.boundary
    error_message = "the stack must hand the demo boundary to modules/blockwarden"
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
    error_message = "the stack must hand the demo boundary to modules/relayer"
  }
}

run "monitor_roles_have_the_boundary" {
  command = plan

  module {
    source = "../../modules/blockwarden"
  }

  variables {
    name                     = "blockwarden-demo"
    monitor_source_dir       = "/nonexistent"
    permissions_boundary_arn = var.boundary
    chains = {
      base = { chain_id = 8453, rpc_urls_parameter = "/blockwarden-demo/rpc/base", lag_alarm_blocks = 300 }
    }
  }

  assert {
    condition     = aws_iam_role.monitor.permissions_boundary == var.boundary && aws_iam_role.scheduler.permissions_boundary == var.boundary
    error_message = "every role modules/blockwarden creates must carry the boundary"
  }
}

run "actions_roles_have_the_boundary" {
  command = plan

  module {
    source = "../../modules/actions"
  }

  variables {
    name                     = "blockwarden-demo"
    actions_source_dir       = "/nonexistent"
    table_name               = "blockwarden-demo"
    table_arn                = "arn:aws:dynamodb:ap-southeast-2:123456789012:table/blockwarden-demo"
    table_stream_arn         = "arn:aws:dynamodb:ap-southeast-2:123456789012:table/blockwarden-demo/stream/2026-01-01T00:00:00.000"
    alarm_topic_arn          = "arn:aws:sns:ap-southeast-2:123456789012:blockwarden-demo-alarms"
    permissions_boundary_arn = var.boundary
  }

  assert {
    condition     = aws_iam_role.actions["dispatcher"].permissions_boundary == var.boundary && aws_iam_role.actions["sender"].permissions_boundary == var.boundary && aws_iam_role.scheduler.permissions_boundary == var.boundary
    error_message = "every role modules/actions creates must carry the boundary"
  }
}

run "api_roles_have_the_boundary" {
  command = plan

  module {
    source = "../../modules/api"
  }

  variables {
    name           = "blockwarden-demo"
    api_source_dir = "/nonexistent"
    table          = { name = "blockwarden-demo", arn = "arn:aws:dynamodb:ap-southeast-2:123456789012:table/blockwarden-demo" }
    queues = {
      delivery       = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/d", arn = "arn:aws:sqs:ap-southeast-2:123456789012:d" }
      dead_letter    = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/l", arn = "arn:aws:sqs:ap-southeast-2:123456789012:l" }
      stream_failure = { url = "https://sqs.ap-southeast-2.amazonaws.com/123456789012/s", arn = "arn:aws:sqs:ap-southeast-2:123456789012:s" }
    }
    chains                   = { base = { chain_id = 8453, rpc_urls_parameter = "/blockwarden-demo/rpc/base" } }
    alarm_topic_arn          = "arn:aws:sns:ap-southeast-2:123456789012:blockwarden-demo-alarms"
    permissions_boundary_arn = var.boundary
  }

  assert {
    condition     = aws_iam_role.api.permissions_boundary == var.boundary && aws_iam_role.authorizer.permissions_boundary == var.boundary
    error_message = "every role modules/api creates must carry the boundary"
  }
}

run "relayer_roles_have_the_boundary" {
  command = plan

  module {
    source = "../../modules/relayer"
  }

  variables {
    name                     = "blockwarden-demo"
    relayer_source_dir       = "/nonexistent"
    permissions_boundary_arn = var.boundary
    chains                   = { base-sepolia = { chain_id = 84532, rpc_urls_parameter = "/blockwarden-demo/rpc/base-sepolia" } }
    signers = {
      demo = {
        chain_ids                    = [84532]
        allowed_to                   = [{ address = "0x000000000000000000000000000000000000dEaD", selectors = ["0x"] }]
        max_gas_limit                = 500000
        max_fee_per_gas_wei          = "5000000000"
        max_priority_fee_per_gas_wei = "2000000000"
        daily_spend_cap_wei          = "50000000000000000"
      }
    }
  }

  assert {
    condition     = aws_iam_role.api.permissions_boundary == var.boundary && aws_iam_role.signer.permissions_boundary == var.boundary && aws_iam_role.sweeper.permissions_boundary == var.boundary && aws_iam_role.scheduler.permissions_boundary == var.boundary
    error_message = "every role modules/relayer creates must carry the boundary"
  }
}
