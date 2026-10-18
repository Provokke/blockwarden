variable "region" {
  description = "Region for the state bucket. The apply roles are scoped to this region, so the staging and demo stacks must deploy here too; the workflows pass it to them as BLOCKWARDEN_AWS_REGION."
  type        = string
  default     = "ap-southeast-2"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.region))
    error_message = "region must be an AWS region name, such as ap-southeast-2."
  }
}

variable "github_repository" {
  description = "The GitHub repository the workflows run in, as owner/name. The gh variable set commands in the outputs name it; the trust policies use github_sub_prefix."
  type        = string
  default     = "Provokke/blockwarden"

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository must be owner/name, with no wildcard."
  }
}

variable "github_sub_prefix" {
  description = "The repository part of the sub claim GitHub writes for this repository, repo:<owner>@<owner id>/<name>@<repository id>. Read it from the sub_claim_prefix field of: gh api repos/<owner>/<name>/actions/oidc/customization/sub"
  type        = string
  default     = "repo:Provokke@70989453/blockwarden@1371434855"

  # the pattern has no place for a *, which would become a wildcard in every trust policy's sub
  validation {
    condition     = can(regex("^repo:[A-Za-z0-9-]+@[0-9]+/[A-Za-z0-9._-]+@[0-9]+$", var.github_sub_prefix))
    error_message = "github_sub_prefix must be repo:<owner>@<owner id>/<name>@<repository id>, with no wildcard."
  }
}

variable "state_bucket_name" {
  description = "Name for the state bucket. Leave null for blockwarden-tfstate-<account id>-<region>, which is unique by construction."
  type        = string
  default     = null

  validation {
    condition     = var.state_bucket_name == null ? true : can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "state_bucket_name must be a valid S3 bucket name."
  }
}

variable "existing_oidc_provider_arn" {
  description = "ARN of a GitHub OIDC provider the account already has. An account holds one provider per URL, so creating a second fails; set this to adopt the existing one instead."
  type        = string
  default     = null

  validation {
    condition     = var.existing_oidc_provider_arn == null ? true : can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token[.]actions[.]githubusercontent[.]com$", var.existing_oidc_provider_arn))
    error_message = "existing_oidc_provider_arn must be the ARN of the token.actions.githubusercontent.com provider."
  }
}
