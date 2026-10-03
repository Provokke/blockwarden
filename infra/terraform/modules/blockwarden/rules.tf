# A rule Terraform writes keeps its body as one JSON string, because Terraform cannot build an arbitrarily
# nested DynamoDB map. The monitor and the dispatcher both read inputJson when there is no input.
resource "aws_dynamodb_table_item" "rule" {
  for_each   = var.rules
  table_name = aws_dynamodb_table.main.name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode(merge(
    {
      PK     = { S = "RULE#${each.key}" }
      SK     = { S = "META" }
      ruleId = { S = each.key }
      active = { BOOL = each.value.active }
      # conditions is merged in rather than set to null: the schema takes the key as absent, not as null
      inputJson = { S = jsonencode(merge(
        {
          chainId      = each.value.chain_id
          addresses    = each.value.addresses
          event        = each.value.event
          confirmation = { mode = each.value.confirmation_mode }
          actions      = [for a in each.value.actions : jsondecode(a)]
        },
        each.value.conditions == null ? {} : { conditions = jsondecode(each.value.conditions) },
      )) }
      chainId   = { N = tostring(each.value.chain_id) }
      createdAt = { S = "terraform" }
      updatedAt = { S = "terraform" }
    },
    each.value.active ? {
      GSI1PK = { S = "CHAIN#${each.value.chain_id}#RULES" }
      GSI1SK = { S = "RULE#${each.key}" }
    } : {},
  ))
}
