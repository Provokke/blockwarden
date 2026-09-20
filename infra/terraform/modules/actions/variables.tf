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

  validation {
    condition     = var.webhook_secret_parameter == null ? true : startswith(var.webhook_secret_parameter, "/")
    error_message = "webhook_secret_parameter must be an SSM parameter name starting with /."
  }
}

variable "telegram_token_parameter" {
  description = "SSM SecureString holding the Telegram bot token. Leave null to switch the channel off."
  type        = string
  default     = null

  validation {
    condition     = var.telegram_token_parameter == null ? true : startswith(var.telegram_token_parameter, "/")
    error_message = "telegram_token_parameter must be an SSM parameter name starting with /."
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
}

variable "allowed_target_arns" {
  description = "SQS queue and Lambda function ARNs a rule may deliver to. Anything not listed is refused by the sender and by its IAM policy."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for arn in var.allowed_target_arns : can(regex("^arn:aws[a-z-]*:(sqs|lambda):", arn))])
    error_message = "allowed_target_arns takes SQS queue and Lambda function ARNs only."
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

  validation {
    condition     = alltrue([for prefix in var.outbound_secret_prefixes : startswith(prefix, "/")])
    error_message = "every outbound_secret_prefixes entry must start with /."
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
