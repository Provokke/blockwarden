data "archive_file" "monitor" {
  type        = "zip"
  source_dir  = var.monitor_source_dir
  output_path = "${path.root}/.build/monitor.zip"
}

resource "aws_cloudwatch_log_group" "monitor" {
  #checkov:skip=CKV_AWS_158:operational logs only; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough for a scheduled poller
  for_each          = var.chains
  name              = "/aws/lambda/${var.name}-monitor-${each.key}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitor" {
  name               = "${var.name}-monitor"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "monitor" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "TableIndexes"
    actions   = ["dynamodb:Query"]
    resources = ["${aws_dynamodb_table.main.arn}/index/*"]
  }

  statement {
    sid       = "RpcUrls"
    actions   = ["ssm:GetParameter"]
    resources = [for c in var.chains : "arn:aws:ssm:${local.region}:${local.account_id}:parameter${c.rpc_urls_parameter}"]
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
    resources = [for g in aws_cloudwatch_log_group.monitor : "${g.arn}:*"]
  }
}

resource "aws_iam_role_policy" "monitor" {
  name   = "monitor"
  role   = aws_iam_role.monitor.id
  policy = data.aws_iam_policy_document.monitor.json
}

resource "aws_lambda_function" "monitor" {
  #checkov:skip=CKV_AWS_50:tracing is not needed for a one-minute poller
  #checkov:skip=CKV_AWS_115:reserved concurrency fails on accounts with the default quota of 10; a per-chain DynamoDB lease already stops overlapping runs
  #checkov:skip=CKV_AWS_116:invoked on a schedule with retries off; the next scheduled run picks up a failed poll
  #checkov:skip=CKV_AWS_117:only calls public RPC endpoints and DynamoDB; a VPC would need a NAT gateway
  #checkov:skip=CKV_AWS_173:the environment holds no secrets; RPC URLs are read from SSM at runtime
  #checkov:skip=CKV_AWS_272:code signing is out of scope for v1
  for_each         = var.chains
  function_name    = "${var.name}-monitor-${each.key}"
  role             = aws_iam_role.monitor.arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.monitor.output_path
  source_code_hash = data.archive_file.monitor.output_base64sha256
  memory_size      = 256
  timeout          = 60

  environment {
    variables = merge(
      {
        TABLE_NAME         = aws_dynamodb_table.main.name
        CHAIN_ID           = tostring(each.value.chain_id)
        RPC_URLS_PARAMETER = each.value.rpc_urls_parameter
        MAX_RANGE          = tostring(each.value.max_range)
        TIME_BUDGET_MS     = "50000"
        NODE_OPTIONS       = "--enable-source-maps"
      },
      each.value.start_block == null ? tomap({}) : tomap({ START_BLOCK = tostring(each.value.start_block) }),
      each.value.finality_depth == null ? tomap({}) : tomap({ FINALITY_DEPTH = tostring(each.value.finality_depth) }),
    )
  }

  depends_on = [aws_cloudwatch_log_group.monitor, aws_iam_role_policy.monitor]
}

resource "aws_lambda_function_event_invoke_config" "monitor" {
  # A failed poll is retried by the next scheduled run; Lambda's own async retries would overlap it.
  for_each                     = var.chains
  function_name                = aws_lambda_function.monitor[each.key].function_name
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
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [for f in aws_lambda_function.monitor : f.arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-monitor"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "monitor" {
  #checkov:skip=CKV_AWS_297:a schedule only holds a function ARN; a customer managed key adds a fixed monthly cost
  for_each            = var.chains
  name                = "${var.name}-monitor-${each.key}"
  schedule_expression = var.schedule_expression

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.monitor[each.key].arn
    role_arn = aws_iam_role.scheduler.arn

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}
