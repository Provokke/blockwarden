# variable "fake_secret" { } in a comment is not a variable
variable "name" {
  description = "Braces { and } and a \"quote\" inside a string."
  type        = string
  default     = "x"

  validation {
    condition     = can(regex("^[a-z]{1,15}$", var.name)) && "${var.name}/" != "$${literal}"
    error_message = "name must match ^[a-z]{1,15}$; sensitive = true here is only text."
  }
}

variable "webhook_secret_parameter" {
  description = "An SSM parameter name, not a secret."
  type        = string
}

variable "chains" {
  type = map(object({
    chain_id           = number
    rpc_urls_parameter = string
  }))
}

variable "password" {
  type      = string
  sensitive = true
}

variable "described_by_heredoc" {
  description = <<-EOT
    variable "heredoc_token" {
      type = string
    }
  EOT
  type        = string
}

/* variable "block_comment_key" { type = string } */
// variable "slash_comment_key" { type = string }
