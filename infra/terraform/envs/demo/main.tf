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
