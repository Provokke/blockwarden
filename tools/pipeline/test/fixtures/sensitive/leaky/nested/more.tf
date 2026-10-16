variable "chains" {
  type = map(object({
    chain_id = number
    rpc_urls = list(string)
  }))
}

variable "signing_key" {
  type = string

  validation {
    condition     = length(var.signing_key) > 0
    error_message = "a sensitive = true inside a string or a nested block does not count"
  }
}
