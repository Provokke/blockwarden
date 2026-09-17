variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "blockwarden"
}

variable "relayer_source_dir" {
  description = "Directory holding the built relayer bundles: api/, signer/ and sweeper/, each with index.mjs."
  type        = string
}

variable "table" {
  description = "An existing Blockwarden table to share, such as the full stack's. Leave null to create one."
  type = object({
    name = string
    arn  = string
  })
  default = null
}

variable "chains" {
  description = "Chains to relay on, keyed by a short name. Each rpc_urls_parameter must be a SecureString encrypted with the default aws/ssm key."
  type = map(object({
    chain_id            = number
    rpc_urls_parameter  = string
    confirmations       = optional(number, 5)
    stuck_after_seconds = optional(number, 90)
  }))

  validation {
    condition     = alltrue([for c in var.chains : startswith(c.rpc_urls_parameter, "/")])
    error_message = "rpc_urls_parameter must be an SSM parameter name starting with /."
  }

  validation {
    condition = alltrue([for c in var.chains :
      c.confirmations >= 1 && c.confirmations == floor(c.confirmations) &&
      c.stuck_after_seconds >= 1 && c.stuck_after_seconds == floor(c.stuck_after_seconds)
    ])
    error_message = "confirmations and stuck_after_seconds must be positive whole numbers."
  }

  validation {
    condition     = alltrue([for c in var.chains : c.chain_id >= 1 && c.chain_id == floor(c.chain_id)])
    error_message = "chain_id must be a positive whole number."
  }

  validation {
    condition     = length(distinct([for c in var.chains : c.chain_id])) == length(var.chains)
    error_message = "chain_id values in chains must be unique."
  }
}

variable "signers" {
  description = "Signers, keyed by signer id. Each gets its own KMS key and a policy the API enforces on every request."
  type = map(object({
    chain_ids = list(number)
    allowed_to = list(object({
      address             = string
      selectors           = optional(list(string))
      transfer_recipients = optional(list(string))
    }))
    max_gas_limit                = number
    max_fee_per_gas_wei          = string
    max_priority_fee_per_gas_wei = string
    daily_spend_cap_wei          = string
    # alarm when the balance on any of its chains drops below this many gwei; null for no alarm
    balance_alarm_gwei = optional(number)
    # read by the actions pipeline in milestone 3 to deliver tx.* events
    webhooks                 = optional(list(string), [])
    webhook_secret_parameter = optional(string)
  }))

  validation {
    condition     = alltrue([for id, s in var.signers : can(regex("^[A-Za-z0-9_-]{1,64}$", id))])
    error_message = "A signer id is 1 to 64 letters, digits, underscores or hyphens."
  }

  validation {
    condition     = alltrue([for s in var.signers : length(s.allowed_to) > 0])
    error_message = "allowed_to must have at least one entry."
  }

  validation {
    condition     = alltrue([for s in var.signers : s.max_gas_limit >= 1 && s.max_gas_limit == floor(s.max_gas_limit)])
    error_message = "max_gas_limit must be a positive whole number."
  }

  validation {
    condition = alltrue(flatten([for s in var.signers : [for t in s.allowed_to : concat(
      [can(regex("^0x[0-9a-fA-F]{40}$", t.address))],
      [for r in coalesce(t.transfer_recipients, []) : can(regex("^0x[0-9a-fA-F]{40}$", r))],
      [for x in coalesce(t.selectors, []) : can(regex("^0x([0-9a-fA-F]{8})?$", x))],
    )]]))
    error_message = "Addresses must be 20-byte hex and selectors 4-byte hex, or 0x for a plain transfer."
  }

  validation {
    condition = alltrue([for s in var.signers : alltrue([
      for v in [s.max_fee_per_gas_wei, s.max_priority_fee_per_gas_wei, s.daily_spend_cap_wei] : can(regex("^[0-9]{1,78}$", v))
    ])])
    error_message = "Wei amounts are decimal strings."
  }

  validation {
    # can() first: tonumber() on a non-decimal string errors outright, and the "Wei amounts are decimal strings"
    # validation above already reports that case on its own
    condition = alltrue([for s in var.signers :
      !can(tonumber(s.max_priority_fee_per_gas_wei)) || !can(tonumber(s.max_fee_per_gas_wei)) ||
      tonumber(s.max_priority_fee_per_gas_wei) <= tonumber(s.max_fee_per_gas_wei)
    ])
    error_message = "max_priority_fee_per_gas_wei cannot exceed max_fee_per_gas_wei."
  }

  validation {
    # mirrors policySchema's .refine in services/relayer/src/policy.ts: the daily counter is kept in gwei so it
    # stays a DynamoDB number JavaScript reads back exactly, which needs it under Number.MAX_SAFE_INTEGER
    condition = alltrue([for s in var.signers :
      !can(tonumber(s.daily_spend_cap_wei)) || floor(tonumber(s.daily_spend_cap_wei) / 1000000000) <= 9007199254740991
    ])
    error_message = "daily_spend_cap_wei is too large to count in gwei."
  }

  validation {
    condition     = alltrue(flatten([for s in var.signers : [for id in s.chain_ids : contains([for c in var.chains : c.chain_id], id)]]))
    error_message = "Every chain id a signer lists must be in chains."
  }

  validation {
    condition = alltrue(flatten([for s in var.signers : [for t in s.allowed_to :
      t.transfer_recipients == null ||
      (length(coalesce(t.selectors, [])) == 1 && lower(t.selectors[0]) == "0xa9059cbb")
    ]]))
    error_message = "An allowed_to entry with transfer_recipients set must have selectors exactly [\"0xa9059cbb\"]."
  }
}

variable "api_keys" {
  description = "API keys to create, keyed by label. Each key is stored in SSM as a SecureString and in Terraform state, and only its SHA-256 goes into the table."
  type = map(object({
    signer_ids = list(string)
  }))
  default = {}

  validation {
    condition     = alltrue(flatten([for k in var.api_keys : [for id in k.signer_ids : contains(keys(var.signers), id)]]))
    error_message = "Every signer id an API key lists must be in signers."
  }
}

variable "api_throttle" {
  description = "API Gateway throttling for every route."
  type = object({
    burst_limit = number
    rate_limit  = number
  })
  default = {
    burst_limit = 10
    rate_limit  = 5
  }
}

variable "schedule_expression" {
  description = "How often the sweeper runs."
  type        = string
  default     = "rate(1 minute)"
}

variable "requeue_after_seconds" {
  description = "A queued transaction older than this is sent to the queue again."
  type        = number
  default     = 600
}

variable "pending_age_alarm_seconds" {
  description = "Alarm when a transaction on a chain has been unsettled for longer than this."
  type        = number
  default     = 1800
}

variable "alarm_topic_arn" {
  description = "SNS topic for alarms, such as the full stack's. Leave null to create one."
  type        = string
  default     = null
}

variable "alarm_email" {
  description = "Email address subscribed to the topic this module creates. Ignored when alarm_topic_arn is set."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the Lambda functions and the API access log."
  type        = number
  default     = 14
}
