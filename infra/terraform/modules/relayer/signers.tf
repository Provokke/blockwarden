resource "aws_kms_key" "signer" {
  #checkov:skip=CKV_AWS_7:AWS KMS cannot rotate asymmetric keys, and a new key would be a new signer address
  for_each                 = var.signers
  description              = "${var.name} relayer signer ${each.key}"
  customer_master_key_spec = "ECC_SECG_P256K1"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.signer_key.json
}

resource "aws_kms_alias" "signer" {
  for_each      = var.signers
  name          = "alias/${var.name}-signer-${each.key}"
  target_key_id = aws_kms_key.signer[each.key].key_id
}

data "aws_iam_policy_document" "signer_key" {
  #checkov:skip=CKV_AWS_109:a key policy's resource "*" means the key itself; the account statement is what keeps the key manageable
  #checkov:skip=CKV_AWS_111:a key policy's resource "*" means the key itself, and signing is limited to the signer and sweeper roles
  #checkov:skip=CKV_AWS_356:a key policy's resource "*" means the key itself and cannot name it before it exists
  # without an account statement nobody could ever change or delete the key
  statement {
    sid       = "Account"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  statement {
    sid       = "Sign"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.signer.arn, aws_iam_role.sweeper.arn]
    }
  }

  # the API derives each signer's address for eth_estimateGas and the signers route; it cannot sign
  statement {
    sid       = "ReadPublicKey"
    actions   = ["kms:GetPublicKey"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.api.arn]
    }
  }
}

locals {
  # DynamoDB JSON for each signer item, in the shape RelayerStore.getSigner validates
  signer_items = { for id, s in var.signers : id => merge(
    {
      PK       = { S = "SIGNER#${id}" }
      SK       = { S = "META" }
      signerId = { S = id }
      keyId    = { S = aws_kms_key.signer[id].arn }
      chainIds = { L = [for c in s.chain_ids : { N = tostring(c) }] }
      webhooks = { L = [for w in s.webhooks : { S = w }] }
      policy = { M = {
        allowedTo = { L = [for t in s.allowed_to : { M = merge(
          { address = { S = t.address } },
          { for k, v in { selectors = t.selectors, transferRecipients = t.transfer_recipients } :
          k => { L = [for x in v : { S = x }] } if v != null },
        ) }] }
        maxGasLimit          = { N = tostring(s.max_gas_limit) }
        maxFeePerGas         = { S = s.max_fee_per_gas_wei }
        maxPriorityFeePerGas = { S = s.max_priority_fee_per_gas_wei }
        dailySpendCapWei     = { S = s.daily_spend_cap_wei }
      } }
    },
    s.webhook_secret_parameter == null ? {} : { webhookSecretParameter = { S = s.webhook_secret_parameter } },
  ) }
}

resource "aws_dynamodb_table_item" "signer" {
  for_each   = var.signers
  table_name = local.table_name
  hash_key   = "PK"
  range_key  = "SK"
  item       = jsonencode(local.signer_items[each.key])
}

resource "random_password" "api_key" {
  for_each = var.api_keys
  length   = 43
  special  = false
}

locals {
  api_keys = { for label, _ in var.api_keys : label => "bw_${random_password.api_key[label].result}" }
}

resource "aws_ssm_parameter" "api_key" {
  #checkov:skip=CKV_AWS_337:the default aws/ssm key encrypts it; a customer managed key adds a fixed monthly cost
  for_each = var.api_keys
  name     = "/${var.name}/relayer/api-keys/${each.key}"
  type     = "SecureString"
  value    = local.api_keys[each.key]
}

resource "aws_dynamodb_table_item" "api_key" {
  for_each   = var.api_keys
  table_name = local.table_name
  hash_key   = "PK"
  range_key  = "SK"
  item = jsonencode({
    PK        = { S = "APIKEY#${sha256(local.api_keys[each.key])}" }
    SK        = { S = "META" }
    signerIds = { L = [for id in each.value.signer_ids : { S = id }] }
    label     = { S = each.key }
  })
}
