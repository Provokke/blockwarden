# How a downstream project deploys the relayer alone: its own table, its own alarm topic, and an API key in SSM.
terraform {
  required_version = ">= 1.16.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.64"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

module "relayer" {
  source             = "../../modules/relayer"
  name               = "billing-relayer"
  relayer_source_dir = "${path.root}/../../../../services/relayer/dist"
  alarm_email        = "ops@example.com"

  chains = {
    base-sepolia = {
      chain_id           = 84532
      rpc_urls_parameter = "/billing/rpc/base-sepolia"
    }
  }

  signers = {
    billing = {
      chain_ids = [84532]
      allowed_to = [
        # USDC on Base Sepolia: transfer only, and only to the treasury
        {
          address             = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
          selectors           = ["0xa9059cbb"]
          transfer_recipients = ["0x000000000000000000000000000000000000bEEF"]
        },
      ]
      max_gas_limit                = 300000
      max_fee_per_gas_wei          = "2000000000"
      max_priority_fee_per_gas_wei = "1000000000"
      daily_spend_cap_wei          = "20000000000000000"
      webhooks                     = ["https://billing.example.com/webhooks/blockwarden"]
      webhook_secret_parameter     = "/billing/webhook-secret"
    }
  }

  api_keys = {
    billing-worker = { signer_ids = ["billing"] }
  }
}

output "api_url" {
  value = module.relayer.api_url
}

output "api_key_parameters" {
  value = module.relayer.api_key_parameters
}
