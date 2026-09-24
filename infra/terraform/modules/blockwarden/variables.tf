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
  description = "Chains to monitor, keyed by a short name. Each rpc_urls_parameter must be a SecureString encrypted with the default aws/ssm key; the monitor role can only decrypt that key. When the api input is also set, the API reads these same parameters and refuses to start if any one holds more than 3 URLs, even though the monitor itself has no such limit."
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

  # the API's rule for the same parameters, which is tighter than the monitor's: the API reads them to verify a
  # contract wallet's login, and refuses a name outside it at cold start
  validation {
    condition = alltrue([for c in var.chains :
      can(regex("^/[A-Za-z0-9_./-]+$", c.rpc_urls_parameter)) && !strcontains(c.rpc_urls_parameter, "..")
    ])
    error_message = "rpc_urls_parameter must be an SSM parameter name: / then letters, digits, _ . / or -, with no .. anywhere in it."
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
    ses_verify_identity       = optional(bool, true)
    ses_configuration_set     = optional(string)
    relayer_api_url           = optional(string)
    relayer_api_key_parameter = optional(string)
    allowed_target_arns       = optional(list(string), [])
    outbound_queue            = optional(bool, false)
    outbound_secret_prefixes  = optional(list(string), [])
    # the prefixes a rule's own webhook action may name; separate from the outbound list on purpose
    rule_secret_prefixes = optional(list(string), [])
    # each relayer signer's webhook_secret_parameter, which the sender reads when it signs that signer's webhook
    signer_webhook_secret_parameters = optional(list(string), [])
    log_level                        = optional(string, "INFO")
  })
  default = null

  # These three repeat modules/actions' own validations. A child module's validation is only evaluated for a
  # value Terraform already knows, and everything below is passed on from this variable, so through this module
  # the child's copy waits for a plan. Here it fails at validate, which is where the two example roots look.
  validation {
    condition = var.actions == null ? true : alltrue([for name in concat(
      var.actions.webhook_secret_parameter == null ? [] : [var.actions.webhook_secret_parameter],
      var.actions.telegram_token_parameter == null ? [] : [var.actions.telegram_token_parameter],
      var.actions.relayer_api_key_parameter == null ? [] : [var.actions.relayer_api_key_parameter],
      var.actions.signer_webhook_secret_parameters,
      ) :
      length(name) <= 1011 && can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", name)) && !contains(split("/", name), "..")
    ])
    error_message = "every SSM parameter name in actions must be / then 1 to 15 levels of letters, digits, _ . or -, no .. level, at most 1011 characters."
  }

  validation {
    condition = var.actions == null ? true : alltrue([for prefix in var.actions.outbound_secret_prefixes :
      startswith(prefix, "/") && length(trimsuffix(prefix, "/")) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", trimsuffix(prefix, "/"))) &&
      !contains(split("/", prefix), "..")
    ])
    error_message = "every actions.outbound_secret_prefixes entry must be an SSM parameter name with an optional trailing slash; \"/\" alone would grant every parameter in the account."
  }

  # the API reads the same list, and refuses a prefix with .. anywhere in it where the dispatcher refuses only a
  # .. level, so this is the stricter of the two
  validation {
    condition = var.actions == null ? true : alltrue([for prefix in var.actions.rule_secret_prefixes :
      startswith(prefix, "/") && length(trimsuffix(prefix, "/")) <= 1011 &&
      can(regex("^(/[A-Za-z0-9_.-]+){1,15}$", trimsuffix(prefix, "/"))) &&
      !strcontains(prefix, "..")
    ])
    error_message = "every actions.rule_secret_prefixes entry must be an SSM parameter name with an optional trailing slash and no ..; \"/\" alone would let a rule name every parameter in the account."
  }

  validation {
    condition = var.actions == null ? true : alltrue([for arn in var.actions.allowed_target_arns : can(regex(
      "^arn:aws[a-z-]*:(sqs:[a-z0-9-]+:[0-9]{12}:([A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-]{1,75}[.]fifo)|lambda:[a-z0-9-]+:[0-9]{12}:function:[A-Za-z0-9_-]{1,140}(:[A-Za-z0-9_$-]+)?)$",
    arn))])
    error_message = "actions.allowed_target_arns takes whole SQS queue and Lambda function ARNs only."
  }
}

variable "api" {
  description = "Deploy the HTTP API and its authorizer alongside the monitor. It lists and redrives the actions pipeline's deliveries, so it needs the actions input too. Leave null to deploy without it."
  type = object({
    source_dir      = string
    allowed_wallets = list(string)
    site_origin     = string
    # the host of site_origin when left out, which is the only value the API accepts
    siwe_domain = optional(string)
  })
  default = null

  # These repeat modules/api's own validations, for the reason given on actions above: through this module the
  # child's copy waits for a plan, and here they fail at validate.
  validation {
    condition     = var.api == null ? true : length(var.api.allowed_wallets) > 0
    error_message = "api.allowed_wallets must name at least one wallet; an empty list is a deployment nobody can sign in to."
  }

  validation {
    condition     = var.api == null ? true : alltrue([for w in var.api.allowed_wallets : can(regex("^0x[0-9a-fA-F]{40}$", w))])
    error_message = "every api.allowed_wallets entry must be a 20-byte hex address."
  }

  validation {
    condition = var.api == null ? true : (
      can(regex("^https://[a-z0-9.-]+$", var.api.site_origin)) &&
      can(regex("^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])*[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.api.site_origin)) &&
      !can(regex("(^https://|[.])([0-9]+|0x[0-9a-f]*)$", var.api.site_origin))
    )
    error_message = "api.site_origin must be https:// then a lowercase host name, with no port, path or trailing slash."
  }

  validation {
    condition     = var.api == null ? true : var.api.siwe_domain == null || var.api.siwe_domain == trimprefix(var.api.site_origin, "https://")
    error_message = "api.siwe_domain must be the host of api.site_origin; leave it out to use that host."
  }

  # names another variable, so this one waits for a plan
  validation {
    condition     = var.api == null || var.actions != null
    error_message = "the API needs the actions pipeline; set the actions input as well."
  }
}

variable "rules" {
  description = "Rules created at apply time, keyed by rule id. conditions and each action are JSON strings, because Terraform cannot type a rule's nested shape. The monitor logs and drops the part of a rule that does not compile: an action that fails its schema is dropped and the rule keeps matching."
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

  # nothing polls a chain that is not in chains, so such a rule is inert and silent
  validation {
    condition     = alltrue([for r in var.rules : contains([for c in var.chains : c.chain_id], r.chain_id)])
    error_message = "every rule's chain_id must be one of the chains."
  }

  # without the actions pipeline a match is stored and nothing is ever delivered
  validation {
    condition     = var.actions != null || alltrue([for r in var.rules : length(r.actions) == 0])
    error_message = "a rule can only carry actions when the actions pipeline is deployed; set the actions input."
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

  # mirrors packages/core's headerName: the RFC 7230 token a header name is, and not one of RESERVED_HEADERS,
  # which the sender computes for itself or which frames the request, such as Host or Content-Length. A name
  # that fails either half compiles here and is then dropped at rule compile, where nobody is watching.
  validation {
    condition = alltrue(flatten([for r in var.rules : [for a in r.actions :
      try(jsondecode(a).type, null) != "webhook" || alltrue([
        for h in [try(jsondecode(a).signatureHeader, null), try(jsondecode(a).deliveryHeader, null)] :
        h == null || (can(regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", h)) && !contains([
          "connection", "content-length", "content-type", "expect", "host", "keep-alive",
          "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "user-agent",
        ], lower(h)))
      ])
    ]]))
    error_message = "a webhook action's signatureHeader and deliveryHeader must each be a header name, and not a reserved header."
  }

  # the dispatcher refuses to build a delivery for an action naming a parameter outside this list, because the
  # sender would otherwise sign the rule's body with somebody else's secret. Caught here at plan rather than as
  # a match that quietly delivers nothing.
  validation {
    condition = alltrue(flatten([for r in var.rules : [for a in r.actions :
      try(jsondecode(a).type, null) != "webhook" || try(jsondecode(a).secretParameter, null) == null || anytrue([
        for p in(var.actions == null ? [] : var.actions.rule_secret_prefixes) :
        startswith(try(jsondecode(a).secretParameter, ""), endswith(p, "/") ? p : "${p}/")
      ])
    ]]))
    error_message = "a webhook action's secretParameter must sit under one of actions.rule_secret_prefixes."
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
