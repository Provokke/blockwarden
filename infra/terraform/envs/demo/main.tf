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
  }
}

variable "region" {
  description = "AWS region for the demo stack."
  type        = string
  default     = "ap-southeast-2"
}

variable "alarm_email" {
  description = "Email address subscribed to alarms."
  type        = string
  default     = null
}

# no default: no one wallet is right for every deployment
variable "allowed_wallets" {
  description = "Wallets that may sign in to the dashboard."
  type        = list(string)
}

variable "site_origin" {
  description = "The origin the dashboard is served from, such as https://blockwarden.example.com. Leave null for the distribution's own cloudfront.net name."
  type        = string
  default     = null
}

# Written by `node scripts/csp-hashes.mjs --out` in apps/dashboard to site.auto.tfvars.json beside this file, which
# Terraform loads by itself. Empty until then, and a dashboard uploaded against an empty list never hydrates.
variable "site_script_hashes" {
  description = "sha256 hashes of the dashboard export's inline scripts."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for h in var.site_script_hashes : can(regex("^sha256-[A-Za-z0-9+/]{43}=$", h))])
    error_message = "every site_script_hashes entry must be sha256- then 43 base64 characters and a =."
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "blockwarden"
      environment = "demo"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  # created by infra/terraform/bootstrap; the apply role can create a role only with this attached
  permissions_boundary_arn = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/blockwarden-demo-boundary"
}

module "blockwarden" {
  source                   = "../../modules/blockwarden"
  name                     = "blockwarden-demo"
  permissions_boundary_arn = local.permissions_boundary_arn
  monitor_source_dir       = "${path.root}/../../../../services/monitor/dist/monitor"
  alarm_email              = var.alarm_email

  chains = {
    ethereum = {
      chain_id           = 1
      rpc_urls_parameter = "/blockwarden-demo/rpc/ethereum"
      lag_alarm_blocks   = 50
    }
    base = {
      chain_id           = 8453
      rpc_urls_parameter = "/blockwarden-demo/rpc/base"
      lag_alarm_blocks   = 300
    }
    arbitrum = {
      chain_id           = 42161
      rpc_urls_parameter = "/blockwarden-demo/rpc/arbitrum"
      lag_alarm_blocks   = 300
    }
  }

  # webhooks only: no SES identity and no Telegram bot token exist for the demo yet. Both senders still deploy
  # and fail closed on the channels that are not configured.
  actions = {
    source_dir               = "${path.root}/../../../../services/actions/dist"
    webhook_secret_parameter = "/blockwarden-demo/webhook-secret"
  }

  api = {
    source_dir      = "${path.root}/../../../../services/api/dist"
    allowed_wallets = var.allowed_wallets
    site_origin     = var.site_origin

    site_script_hashes = var.site_script_hashes
  }
}

# Testnet relaying only. Until the milestone 5 demo contracts exist, the allowlist holds only the burn address, and
# "0x" there allows plain transfers with value to it, up to the 0.05 ETH daily spend cap.
module "relayer" {
  source                   = "../../modules/relayer"
  name                     = "blockwarden-demo"
  permissions_boundary_arn = local.permissions_boundary_arn
  relayer_source_dir       = "${path.root}/../../../../services/relayer/dist"
  table                    = { name = module.blockwarden.table_name, arn = module.blockwarden.table_arn }
  alarm_topic_arn          = module.blockwarden.alarm_topic_arn

  chains = {
    base-sepolia = {
      chain_id           = 84532
      rpc_urls_parameter = "/blockwarden-demo/rpc/base-sepolia"
    }
    arbitrum-sepolia = {
      chain_id           = 421614
      rpc_urls_parameter = "/blockwarden-demo/rpc/arbitrum-sepolia"
    }
  }

  signers = {
    demo = {
      chain_ids                    = [84532, 421614]
      allowed_to                   = [{ address = "0x000000000000000000000000000000000000dEaD", selectors = ["0x"] }]
      max_gas_limit                = 500000
      max_fee_per_gas_wei          = "5000000000"
      max_priority_fee_per_gas_wei = "2000000000"
      daily_spend_cap_wei          = "50000000000000000"
      balance_alarm_gwei           = 10000000
    }
  }
}

output "table_name" {
  value = module.blockwarden.table_name
}

output "monitor_function_names" {
  value = module.blockwarden.monitor_function_names
}

output "alarm_topic_arn" {
  value = module.blockwarden.alarm_topic_arn
}

output "delivery_queue_url" {
  value = module.blockwarden.delivery_queue_url
}

output "delivery_dead_letter_queue_url" {
  value = module.blockwarden.delivery_dead_letter_queue_url
}

output "stream_failure_queue_url" {
  value = module.blockwarden.stream_failure_queue_url
}

output "relayer_api_url" {
  value = module.relayer.api_url
}

output "relayer_signer_key_arns" {
  value = module.relayer.signer_key_arns
}

output "api_endpoint" {
  value = module.blockwarden.api_endpoint
}

output "session_secret_parameter" {
  value = module.blockwarden.session_secret_parameter
}

output "site_bucket" {
  value = module.blockwarden.site_bucket
}

output "distribution_id" {
  value = module.blockwarden.distribution_id
}

output "site_url" {
  value = module.blockwarden.site_url
}
