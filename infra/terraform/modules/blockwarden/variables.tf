variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "blockwarden"
}

variable "monitor_source_dir" {
  description = "Directory holding the built monitor bundle (index.mjs)."
  type        = string
}

variable "chains" {
  description = "Chains to monitor, keyed by a short name. Each rpc_urls_parameter must be a SecureString encrypted with the default aws/ssm key; the monitor role can only decrypt that key."
  type = map(object({
    chain_id           = number
    rpc_urls_parameter = string
    lag_alarm_blocks   = number
    start_block        = optional(number)
    max_range          = optional(number, 2000)
    finality_depth     = optional(number)
  }))

  validation {
    condition     = alltrue([for c in var.chains : c.max_range == null ? true : c.max_range >= 1])
    error_message = "max_range must be at least 1."
  }

  validation {
    condition     = alltrue([for c in var.chains : c.finality_depth == null ? true : c.finality_depth >= 1])
    error_message = "finality_depth must be at least 1."
  }

  validation {
    condition     = alltrue([for c in var.chains : startswith(c.rpc_urls_parameter, "/")])
    error_message = "rpc_urls_parameter must be an SSM parameter name starting with /."
  }

  validation {
    condition     = length(distinct([for c in var.chains : c.chain_id])) == length(var.chains)
    error_message = "chain_id values in chains must be unique."
  }
}

variable "schedule_expression" {
  description = "How often each chain's poller runs."
  type        = string
  default     = "rate(1 minute)"
}

variable "alarm_email" {
  description = "Email address subscribed to alarms. Leave null to skip the subscription."
  type        = string
  default     = null
}

variable "log_retention_days" {
  description = "CloudWatch log retention for the Lambda functions."
  type        = number
  default     = 14
}

variable "actions" {
  description = "Deploy the actions dispatcher and senders alongside the monitor. Leave null to deploy the monitor alone."
  type = object({
    source_dir                = string
    webhook_secret_parameter  = optional(string)
    telegram_token_parameter  = optional(string)
    ses_from_address          = optional(string)
    ses_configuration_set     = optional(string)
    relayer_api_url           = optional(string)
    relayer_api_key_parameter = optional(string)
    allowed_target_arns       = optional(list(string), [])
    outbound_queue            = optional(bool, false)
    outbound_secret_prefixes  = optional(list(string), [])
    log_level                 = optional(string, "INFO")
  })
  default = null
}

variable "rules" {
  description = "Rules created at apply time, keyed by rule id. conditions and each action are JSON strings, because Terraform cannot type a rule's nested shape. The monitor skips a rule that does not compile and logs it."
  type = map(object({
    chain_id          = number
    addresses         = list(string)
    event             = string
    confirmation_mode = string
    conditions        = optional(string)
    actions           = optional(list(string), [])
    active            = optional(bool, true)
  }))
  default = {}

  validation {
    condition     = alltrue([for r in var.rules : contains(["fast", "finalized"], r.confirmation_mode)])
    error_message = "confirmation_mode must be fast or finalized."
  }

  validation {
    condition     = alltrue([for r in var.rules : length(r.addresses) >= 1 && length(r.addresses) <= 50])
    error_message = "a rule needs between 1 and 50 addresses."
  }

  validation {
    condition     = alltrue([for r in var.rules : alltrue([for a in r.addresses : can(regex("^0x[0-9a-fA-F]{40}$", a))])])
    error_message = "every rule address must be a 20-byte hex address."
  }

  validation {
    condition     = alltrue([for r in var.rules : startswith(r.event, "event ")])
    error_message = "a rule's event must be a Solidity event signature, starting with \"event \"."
  }

  validation {
    condition     = alltrue([for r in var.rules : length(r.actions) <= 5])
    error_message = "a rule takes at most 5 actions."
  }

  validation {
    condition     = alltrue([for r in var.rules : alltrue([for a in r.actions : can(jsondecode(a)) && can(jsondecode(a).type)])])
    error_message = "every action must be a JSON object with a type."
  }

  validation {
    condition     = alltrue([for r in var.rules : r.conditions == null ? true : can(jsondecode(r.conditions))])
    error_message = "conditions must be a JSON string."
  }

  # mirrors packages/core's RESERVED_HEADERS: a webhook action must not name a header the sender computes for
  # itself or that frames the request, such as Host or Content-Length
  validation {
    condition = alltrue(flatten([for r in var.rules : [for a in r.actions :
      try(jsondecode(a).type, null) != "webhook" || alltrue([
        for h in [try(jsondecode(a).signatureHeader, null), try(jsondecode(a).deliveryHeader, null)] :
        h == null || !contains([
          "connection", "content-length", "content-type", "expect", "host", "keep-alive",
          "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "user-agent",
        ], lower(h))
      ])
    ]]))
    error_message = "a webhook action's signatureHeader and deliveryHeader must not be a reserved header."
  }

  # one name for both headers means one of them is never sent; a name left out still counts, since the sender
  # falls back to its own default
  validation {
    condition = alltrue(flatten([for r in var.rules : [for a in r.actions :
      try(jsondecode(a).type, null) != "webhook" || (
        lower(coalesce(try(jsondecode(a).signatureHeader, null), "x-blockwarden-signature")) !=
        lower(coalesce(try(jsondecode(a).deliveryHeader, null), "x-blockwarden-delivery"))
      )
    ]]))
    error_message = "a webhook action's signatureHeader and deliveryHeader must not be the same header."
  }
}
