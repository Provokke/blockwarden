variable "webhook_secret" {
  type    = string
  default = "canary-value-do-not-print"
}

variable "api_token" {
  type      = string
  sensitive = false
}

variable "settings" {
  # sensitive = true
  type = object({
    region = string
    auth = object({
      password = optional(string)
    })
  })
}
