locals {
  environments = toset(["staging", "demo"])

  # The most any role a stack creates may ever do: the union of what the modules' Lambda and scheduler roles are
  # granted (modules/*/functions.tf, monitor.tf and main.tf), for that stack's names only. An apply role can
  # create a role only with this attached, so it cannot mint one that does more than the stack's own functions.
  # A deployment that sets ses_from_address or allowed_target_arns needs those grants added here first.
  boundary_policies = { for env in local.environments : env => {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Table"
        Effect = "Allow"
        Action = ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = [
          "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-${env}",
          "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-${env}/index/*",
        ]
      },
      {
        Sid      = "Stream"
        Effect   = "Allow"
        Action   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
        Resource = ["arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-${env}/stream/*"]
      },
      {
        # the dispatcher's grant: ListStreams has no resource type in IAM
        Sid      = "ListStreams"
        Effect   = "Allow"
        Action   = ["dynamodb:ListStreams"]
        Resource = ["*"]
      },
      {
        Sid      = "Queues"
        Effect   = "Allow"
        Action   = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:SendMessage"]
        Resource = ["arn:${format(local.region_arn, "sqs")}:blockwarden-${env}-*"]
      },
      {
        # RPC URLs, the webhook secret and the session secret all sit under the stack's own path
        Sid      = "Parameters"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = ["arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-${env}/*"]
      },
      {
        Sid       = "DecryptParameters"
        Effect    = "Allow"
        Action    = ["kms:Decrypt"]
        Resource  = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${var.region}.amazonaws.com" } }
      },
      {
        # signer key ids are random; the stack's default tags are what tie a key to it
        Sid       = "SignerKeys"
        Effect    = "Allow"
        Action    = ["kms:GetPublicKey", "kms:Sign"]
        Resource  = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        Sid      = "Logs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:${format(local.region_arn, "logs")}:log-group:/aws/lambda/blockwarden-${env}-*:*"]
      },
      {
        # the scheduler roles invoke the pollers, the reaper and the sweeper
        Sid      = "Invoke"
        Effect   = "Allow"
        Action   = ["lambda:InvokeFunction"]
        Resource = ["arn:${format(local.region_arn, "lambda")}:function:blockwarden-${env}-*"]
      },
    ]
  } }
}

resource "aws_iam_policy" "boundary" {
  for_each    = local.environments
  name        = "blockwarden-${each.key}-boundary"
  description = "The most a role in the ${each.key} stack may do."
  policy      = jsonencode(local.boundary_policies[each.key])
}
