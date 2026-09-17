locals {
  functions = {
    api     = { timeout = 15, memory = 256 }
    signer  = { timeout = 30, memory = 256 }
    sweeper = { timeout = 60, memory = 256 }
  }

  function_env = {
    api = {
      QUEUE_URL = aws_sqs_queue.txs.url
    }
    signer = {
      QUEUE_URL = aws_sqs_queue.txs.url
    }
    # each reported balance is a custom metric, so the sweeper reports only signers with a balance alarm
    sweeper = {
      QUEUE_URL             = aws_sqs_queue.txs.url
      SIGNER_IDS            = join(",", [for id, s in var.signers : id if s.balance_alarm_gwei != null])
      REQUEUE_AFTER_SECONDS = tostring(var.requeue_after_seconds)
    }
  }

  function_roles = {
    api     = aws_iam_role.api.arn
    signer  = aws_iam_role.signer.arn
    sweeper = aws_iam_role.sweeper.arn
  }

  signer_key_arns = [for k in aws_kms_key.signer : k.arn]
}

data "archive_file" "relayer" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.relayer_source_dir}/${each.key}"
  output_path = "${path.root}/.build/relayer-${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "relayer" {
  #checkov:skip=CKV_AWS_158:operational logs only; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough to investigate a relayed transaction; its record stays in the table
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-relayer-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "api" {
  name               = "${var.name}-relayer-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "signer" {
  name               = "${var.name}-relayer-signer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "sweeper" {
  name               = "${var.name}-relayer-sweeper"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "common" {
  for_each = local.functions

  statement {
    sid       = "RpcUrls"
    actions   = ["ssm:GetParameter"]
    resources = local.rpc_parameter_arns
  }

  statement {
    sid       = "DecryptRpcUrls"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.relayer[each.key].arn}:*"]
  }
}

data "aws_iam_policy_document" "api" {
  source_policy_documents = [data.aws_iam_policy_document.common["api"].json]

  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [local.table_arn]
  }

  statement {
    sid       = "Enqueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.txs.arn]
  }

  statement {
    sid       = "SignerAddresses"
    actions   = ["kms:GetPublicKey"]
    resources = local.signer_key_arns
  }
}

data "aws_iam_policy_document" "signer" {
  source_policy_documents = [data.aws_iam_policy_document.common["signer"].json]

  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [local.table_arn]
  }

  statement {
    sid       = "Queue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"]
    resources = [aws_sqs_queue.txs.arn]
  }

  statement {
    sid       = "Sign"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = local.signer_key_arns
  }
}

data "aws_iam_policy_document" "sweeper" {
  source_policy_documents = [data.aws_iam_policy_document.common["sweeper"].json]

  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [local.table_arn]
  }

  statement {
    sid       = "PendingIndex"
    actions   = ["dynamodb:Query"]
    resources = ["${local.table_arn}/index/GSI2"]
  }

  statement {
    sid       = "Requeue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.txs.arn]
  }

  statement {
    sid       = "Sign"
    actions   = ["kms:Sign", "kms:GetPublicKey"]
    resources = local.signer_key_arns
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "relayer-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy" "signer" {
  name   = "relayer-signer"
  role   = aws_iam_role.signer.id
  policy = data.aws_iam_policy_document.signer.json
}

resource "aws_iam_role_policy" "sweeper" {
  name   = "relayer-sweeper"
  role   = aws_iam_role.sweeper.id
  policy = data.aws_iam_policy_document.sweeper.json
}

resource "aws_lambda_function" "relayer" {
  #checkov:skip=CKV_AWS_50:tracing is not needed; every transaction keeps its own history in the table
  #checkov:skip=CKV_AWS_115:reserved concurrency fails on accounts with the default quota of 10; FIFO groups already serialise each signer
  #checkov:skip=CKV_AWS_116:the API is synchronous, the signer's failures go to the queue's dead-letter queue, and the sweeper runs again next minute
  #checkov:skip=CKV_AWS_117:only calls public RPC endpoints and AWS APIs; a VPC would need a NAT gateway
  #checkov:skip=CKV_AWS_173:the environment holds no secrets; RPC URLs are read from SSM at runtime
  #checkov:skip=CKV_AWS_272:code signing is out of scope for v1
  for_each         = local.functions
  function_name    = "${var.name}-relayer-${each.key}"
  role             = local.function_roles[each.key]
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.relayer[each.key].output_path
  source_code_hash = data.archive_file.relayer[each.key].output_base64sha256
  memory_size      = each.value.memory
  timeout          = each.value.timeout

  environment {
    variables = merge(
      {
        TABLE_NAME   = local.table_name
        CHAINS       = local.chains_env
        NODE_OPTIONS = "--enable-source-maps"
      },
      local.function_env[each.key],
    )
  }

  depends_on = [aws_cloudwatch_log_group.relayer, aws_iam_role_policy.api, aws_iam_role_policy.signer, aws_iam_role_policy.sweeper]
}

resource "aws_lambda_event_source_mapping" "signer" {
  event_source_arn        = aws_sqs_queue.txs.arn
  function_name           = aws_lambda_function.relayer["signer"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function_event_invoke_config" "sweeper" {
  # a failed sweep is retried by the next scheduled run; Lambda's own async retries would overlap it
  function_name                = aws_lambda_function.relayer["sweeper"].function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 60
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-relayer-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.relayer["sweeper"].arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-sweeper"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "sweeper" {
  #checkov:skip=CKV_AWS_297:a schedule only holds a function ARN; a customer managed key adds a fixed monthly cost
  name                = "${var.name}-relayer-sweeper"
  schedule_expression = var.schedule_expression

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.relayer["sweeper"].arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
