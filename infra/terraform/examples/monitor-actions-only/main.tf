# The monitor and the actions pipeline, with no relayer and no dashboard: what a downstream project needs when
# it only wants matches delivered. Build the bundles first:
#   pnpm --filter @blockwarden/monitor run build
#   pnpm --filter @blockwarden/actions run build

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

module "blockwarden" {
  source = "../../modules/blockwarden"

  name               = "bw-example"
  monitor_source_dir = "${path.root}/../../../../services/monitor/dist/monitor"

  chains = {
    base = {
      chain_id           = 8453
      rpc_urls_parameter = "/bw-example/rpc/base"
      lag_alarm_blocks   = 300
    }
  }

  actions = {
    source_dir               = "${path.root}/../../../../services/actions/dist"
    webhook_secret_parameter = "/bw-example/webhook-secret"
    outbound_queue           = true
    outbound_secret_prefixes = ["/bw-example/merchants/"]
  }

  rules = {
    usdc-large-transfers = {
      chain_id          = 8453
      addresses         = ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]
      event             = "event Transfer(address indexed from, address indexed to, uint256 value)"
      confirmation_mode = "finalized"
      conditions        = jsonencode({ all = [{ field = "args.value", op = "gte", value = "1000000000000" }] })
      actions           = [jsonencode({ type = "webhook", url = "https://example.com/hook" })]
    }
  }
}

output "delivery_queue_url" {
  value = module.blockwarden.delivery_queue_url
}

output "outbound_queue_url" {
  value = module.blockwarden.outbound_queue_url
}
