variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "blockwarden"
}

variable "actions_source_dir" {
  description = "Directory holding the built actions bundles (dispatcher/ and sender/)."
  type        = string
}

variable "table_name" {
  description = "Name of the table the monitor and relayer share."
  type        = string
}

variable "table_arn" {
  description = "ARN of that table."
  type        = string
}

variable "table_stream_arn" {
  description = "Stream ARN of that table; the dispatcher reads it."
  type        = string
}

variable "alarm_topic_arn" {
  description = "SNS topic every alarm publishes to."
  type        = string
}

variable "webhook_secret_parameter" {
  description = "SSM SecureString holding the default webhook HMAC secret. Several comma-separated secrets are allowed while one is rotating; the sender signs with each of them."
  type        = string
  default     = null

  # mirrors packages/core's parameterName: anything looser passes apply and then kills both Lambdas at cold start
  validation {
    condition = var.webhook_secret_parameter == null ? true : (
      length(var.webhook_secret_parameter) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", var.webhook_secret_parameter)) &&
      !contains(split("/", var.webhook_secret_parameter), "..")
    )
    error_message = "webhook_secret_parameter must be an SSM parameter name: / then 1 to 15 levels of letters, digits, _ . or -, no .. level, at most 1011 characters."
  }
}

variable "telegram_token_parameter" {
  description = "SSM SecureString holding the Telegram bot token. Leave null to switch the channel off."
  type        = string
  default     = null

  validation {
    condition = var.telegram_token_parameter == null ? true : (
      length(var.telegram_token_parameter) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", var.telegram_token_parameter)) &&
      !contains(split("/", var.telegram_token_parameter), "..")
    )
    error_message = "telegram_token_parameter must be an SSM parameter name: / then 1 to 15 levels of letters, digits, _ . or -, no .. level, at most 1011 characters."
  }
}

variable "ses_from_address" {
  description = "Verified SES sender address. Leave null to switch the email channel off. A new SES account is in the sandbox, where every recipient must be verified too."
  type        = string
  default     = null
}

variable "ses_verify_identity" {
  description = "Create an SES v2 email identity for ses_from_address. The address still has to be confirmed from the email AWS sends."
  type        = bool
  default     = true
}

variable "ses_configuration_set" {
  description = "SES configuration set name, for a deployment that already has one."
  type        = string
  default     = null
}

variable "relayer_api_url" {
  description = "Base URL of the relayer API, for the relay action type. Needs relayer_api_key_parameter."
  type        = string
  default     = null
}

variable "relayer_api_key_parameter" {
  description = "SSM SecureString holding an API key for that relayer."
  type        = string
  default     = null

  validation {
    condition = var.relayer_api_key_parameter == null ? true : (
      length(var.relayer_api_key_parameter) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", var.relayer_api_key_parameter)) &&
      !contains(split("/", var.relayer_api_key_parameter), "..")
    )
    error_message = "relayer_api_key_parameter must be an SSM parameter name: / then 1 to 15 levels of letters, digits, _ . or -, no .. level, at most 1011 characters."
  }
}

variable "signer_webhook_secret_parameters" {
  description = "SSM SecureStrings named by a relayer signer's webhook_secret_parameter. The sender reads the signer's own secret when it signs a relay webhook, and can read nothing that is not listed here."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([for name in var.signer_webhook_secret_parameters :
      length(name) <= 1011 && can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", name)) && !contains(split("/", name), "..")
    ])
    error_message = "every signer_webhook_secret_parameters entry must be an SSM parameter name: / then 1 to 15 levels of letters, digits, _ . or -, no .. level, at most 1011 characters."
  }
}

variable "allowed_target_arns" {
  description = "SQS queue and Lambda function ARNs a rule may deliver to. Anything not listed is refused by the sender and by its IAM policy."
  type        = list(string)
  default     = []

  # mirrors the targetArn regex in services/actions/src/config.ts, whole ARN and all; a prefix check passes an
  # ARN the sender then refuses at cold start
  validation {
    condition = alltrue([for arn in var.allowed_target_arns : can(regex(
      "^arn:aws[a-z-]*:(sqs:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]{1,80}|lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]{1,140}(:[A-Za-z0-9_$-]+)?)$",
    arn))])
    error_message = "allowed_target_arns takes whole SQS queue and Lambda function ARNs only."
  }
}

variable "outbound_queue" {
  description = "Create the queue that accepts signed deliveries which did not come from a match."
  type        = bool
  default     = false
}

variable "outbound_secret_prefixes" {
  description = "SSM parameter prefixes an outbound request may name. The sender can read nothing else."
  type        = list(string)
  default     = []

  # same rule as secretPrefixes() in services/actions/src/config.ts: a prefix is a parameter name with an
  # optional trailing slash. "/" alone is not one - it expands to parameter/* and grants the whole account.
  validation {
    condition = alltrue([for prefix in var.outbound_secret_prefixes :
      startswith(prefix, "/") && length(trimsuffix(prefix, "/")) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", trimsuffix(prefix, "/"))) &&
      !contains(split("/", prefix), "..")
    ])
    error_message = "every outbound_secret_prefixes entry must be an SSM parameter name with an optional trailing slash; \"/\" alone would grant every parameter in the account."
  }
}

variable "log_level" {
  description = "POWERTOOLS_LOG_LEVEL for both functions."
  type        = string
  default     = "INFO"

  validation {
    condition     = contains(["DEBUG", "INFO", "WARN", "ERROR", "SILENT"], var.log_level)
    error_message = "log_level must be one of DEBUG, INFO, WARN, ERROR, SILENT."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention for both functions."
  type        = number
  default     = 14
}

variable "schedule_expression" {
  description = "How often the reaper runs."
  type        = string
  default     = "rate(1 minute)"
}

# exists only to host a cross-variable validation; nothing sets it
# tflint-ignore: terraform_unused_declarations
variable "relayer_api_pair" {
  description = "Guard: both relayer settings or neither."
  type        = bool
  default     = true

  validation {
    # a validation condition must refer to its own variable; relayer_api_pair defaults to true and stays there,
    # so this only ever gates on the parenthesised pairing check
    condition     = var.relayer_api_pair && (var.relayer_api_url == null) == (var.relayer_api_key_parameter == null)
    error_message = "set both relayer_api_url and relayer_api_key_parameter, or neither."
  }
}
