variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "blockwarden"
}

variable "api_source_dir" {
  description = "Directory holding the built API bundles: api/ and authorizer/, each with index.mjs."
  type        = string
}

variable "table" {
  description = "The Blockwarden table the API reads and writes."
  type = object({
    name = string
    arn  = string
  })
}

variable "queues" {
  description = "The actions pipeline's queues: the API redrives onto delivery and reports the depth of all three."
  type = object({
    delivery       = object({ url = string, arn = string })
    dead_letter    = object({ url = string, arn = string })
    stream_failure = object({ url = string, arn = string })
  })
}

# every validation below mirrors a check in services/api/src/config.ts, which refuses the same values at cold start
variable "chains" {
  description = "Chains a contract wallet can sign in from, keyed by a short name. Each rpc_urls_parameter must be a SecureString encrypted with the default aws/ssm key, holding at most 3 comma-separated URLs."
  type = map(object({
    chain_id           = number
    rpc_urls_parameter = string
  }))

  validation {
    condition     = length(var.chains) > 0
    error_message = "chains must name at least one chain."
  }

  validation {
    condition     = alltrue([for c in var.chains : c.chain_id >= 1 && c.chain_id == floor(c.chain_id)])
    error_message = "chain_id must be a positive whole number."
  }

  validation {
    condition     = length(distinct([for c in var.chains : c.chain_id])) == length(var.chains)
    error_message = "chain_id values in chains must be unique."
  }

  validation {
    condition = alltrue([for c in var.chains :
      can(regex("^/[A-Za-z0-9_./-]+$", c.rpc_urls_parameter)) && !strcontains(c.rpc_urls_parameter, "..")
    ])
    error_message = "rpc_urls_parameter must be an SSM parameter name: / then letters, digits, _ . / or -, with no .. anywhere in it."
  }
}

variable "allowed_wallets" {
  description = "Wallets that may sign in to the dashboard. A mixed-case address must carry a valid EIP-55 checksum, which only the API can check: a bad one fails its cold start."
  type        = list(string)

  # an empty list is a deployment nobody can sign in to, which would otherwise only show at a login attempt
  validation {
    condition     = length(var.allowed_wallets) > 0
    error_message = "allowed_wallets must name at least one wallet."
  }

  validation {
    condition     = alltrue([for w in var.allowed_wallets : can(regex("^0x[0-9a-fA-F]{40}$", w))])
    error_message = "every allowed_wallets entry must be a 20-byte hex address."
  }
}

variable "site_origin" {
  description = "The origin the dashboard is served from, such as https://blockwarden.example.com: no port, path or trailing slash. Leave null for the distribution's own https://<id>.cloudfront.net name."
  type        = string
  default     = null

  # A lowercase host name, because the API compares this with new URL(SITE_ORIGIN).origin, which lowercases the
  # host and turns a host whose last label is a number into an IPv4 address; either would not compare equal.
  validation {
    condition = var.site_origin == null ? true : (
      can(regex("^https://[a-z0-9.-]+$", var.site_origin)) &&
      can(regex("^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])*[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.site_origin)) &&
      !can(regex("(^https://|[.])([0-9]+|0x[0-9a-f]*)$", var.site_origin))
    )
    error_message = "site_origin must be https:// then a lowercase host name, with no port, path or trailing slash."
  }
}

variable "siwe_domain" {
  description = "The domain a sign-in message must name: the host of site_origin. Leave null to use that host."
  type        = string
  default     = null

  validation {
    condition = var.siwe_domain == null ? true : (
      can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])*[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.siwe_domain)) &&
      !can(regex("(^|[.])([0-9]+|0x[0-9a-f]*)$", var.siwe_domain))
    )
    error_message = "siwe_domain must be a lowercase host name, with no scheme, port or path."
  }

  # Two settings that disagree make every login fail with a message about domains that names neither. With no
  # site_origin the host is the distribution's, which nobody can know before it exists.
  validation {
    condition     = var.siwe_domain == null ? true : var.site_origin == null ? false : var.siwe_domain == trimprefix(var.site_origin, "https://")
    error_message = "siwe_domain must be the host of site_origin, and can only be set with it; leave it out to use that host."
  }
}

variable "rule_secret_prefixes" {
  description = "SSM parameter prefixes a rule's webhook action may name in secretParameter. Pass the actions pipeline's own list, so the API accepts exactly the rules the dispatcher will deliver."
  type        = list(string)
  default     = []

  # the stricter of modules/actions' rule and the API's: the same list reaches both, and each refuses at cold start
  validation {
    condition = alltrue([for prefix in var.rule_secret_prefixes :
      startswith(prefix, "/") && length(trimsuffix(prefix, "/")) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", trimsuffix(prefix, "/"))) &&
      !strcontains(prefix, "..")
    ])
    error_message = "every rule_secret_prefixes entry must be an SSM parameter name with an optional trailing slash and no ..; \"/\" alone would let a rule name every parameter in the account."
  }
}

variable "alarm_topic_arn" {
  description = "SNS topic for the API's alarms."
  type        = string
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

variable "log_retention_days" {
  description = "CloudWatch log retention for the two functions and the access log."
  type        = number
  default     = 14
}
