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

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "blockwarden"
      environment = "demo"
    }
  }
}

module "blockwarden" {
  source             = "../../modules/blockwarden"
  name               = "blockwarden-demo"
  monitor_source_dir = "${path.root}/../../../../services/monitor/dist/monitor"
  alarm_email        = var.alarm_email

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
}

# Testnet relaying only. Until the milestone 5 demo contracts exist, the allowlist holds only the burn address, and
# "0x" there allows plain transfers with value to it, up to the 0.05 ETH daily spend cap.
module "relayer" {
  source             = "../../modules/relayer"
  name               = "blockwarden-demo"
  relayer_source_dir = "${path.root}/../../../../services/relayer/dist"
  table              = { name = module.blockwarden.table_name, arn = module.blockwarden.table_arn }
  alarm_topic_arn    = module.blockwarden.alarm_topic_arn

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

output "relayer_api_url" {
  value = module.relayer.api_url
}

output "relayer_signer_key_arns" {
  value = module.relayer.signer_key_arns
}
