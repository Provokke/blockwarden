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
