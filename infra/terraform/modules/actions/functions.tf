data "archive_file" "actions" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.actions_source_dir}/${each.key}"
  output_path = "${path.root}/.build/actions-${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "actions" {
  #checkov:skip=CKV_AWS_158:operational logs only; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough to investigate a delivery; its record stays in the table for thirty days
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-actions-${each.key}"
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

resource "aws_iam_role" "actions" {
  for_each           = local.functions
  name               = "${var.name}-actions-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "dispatcher" {
  statement {
    sid       = "Deliveries"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [var.table_arn]
  }

  statement {
    sid       = "Indexes"
    actions   = ["dynamodb:Query"]
    resources = ["${var.table_arn}/index/*"]
  }

  statement {
    sid       = "Stream"
    actions   = ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"]
    resources = [var.table_stream_arn]
  }

  # ListStreams has no resource type in IAM, so a stream ARN grants nothing and Lambda refuses to create the
  # event source mapping. It only lists stream ARNs; the three statements above are what read this stream.
  statement {
    sid       = "ListStreams"
    actions   = ["dynamodb:ListStreams"]
    resources = ["*"]
  }

  statement {
    sid       = "Enqueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.deliveries.arn]
  }

  # the reaper sweep writes its own dead-letter copy before marking a delivery dead, and Lambda sends a
  # discarded stream batch to the stream-failure queue under this same role
  statement {
    sid       = "DeadLetters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letter.arn, aws_sqs_queue.stream_failures.arn]
  }

  dynamic "statement" {
    for_each = var.outbound_queue ? [1] : []
    content {
      sid       = "Outbound"
      actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      resources = [aws_sqs_queue.outbound[0].arn]
    }
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.actions["dispatcher"].arn}:*"]
  }
}

data "aws_iam_policy_document" "sender" {
  statement {
    sid       = "Deliveries"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [var.table_arn]
  }

  statement {
    sid       = "Queue"
    actions   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:SendMessage"]
    resources = [aws_sqs_queue.deliveries.arn]
  }

  statement {
    sid       = "DeadLetters"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dead_letter.arn]
  }

  dynamic "statement" {
    for_each = length(local.secret_parameter_arns) + length(local.outbound_secret_arns) > 0 ? [1] : []
    content {
      sid       = "Secrets"
      actions   = ["ssm:GetParameter"]
      resources = concat(local.secret_parameter_arns, local.outbound_secret_arns)
    }
  }

  dynamic "statement" {
    for_each = length(local.secret_parameter_arns) + length(local.outbound_secret_arns) > 0 ? [1] : []
    content {
      sid       = "DecryptSecrets"
      actions   = ["kms:Decrypt"]
      resources = [data.aws_kms_alias.ssm.target_key_arn]

      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["ssm.${local.region}.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = var.ses_from_address == null ? [] : [1]
    content {
      sid       = "Email"
      actions   = ["ses:SendEmail"]
      resources = ["*"]

      # the role may send only as this address, whatever a rule asks for
      condition {
        test     = "StringEquals"
        variable = "ses:FromAddress"
        values   = [var.ses_from_address]
      }
    }
  }

  dynamic "statement" {
    for_each = length(local.target_queue_arns) > 0 ? [1] : []
    content {
      sid       = "TargetQueues"
      actions   = ["sqs:SendMessage"]
      resources = local.target_queue_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.target_function_arns) > 0 ? [1] : []
    content {
      sid       = "TargetFunctions"
      actions   = ["lambda:InvokeFunction"]
      resources = local.target_function_arns
    }
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.actions["sender"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "dispatcher" {
  name   = "actions-dispatcher"
  role   = aws_iam_role.actions["dispatcher"].id
  policy = data.aws_iam_policy_document.dispatcher.json
}

resource "aws_iam_role_policy" "sender" {
  name   = "actions-sender"
  role   = aws_iam_role.actions["sender"].id
  policy = data.aws_iam_policy_document.sender.json
}

resource "aws_lambda_function" "actions" {
  #checkov:skip=CKV_AWS_50:tracing is not needed; every delivery keeps its own attempts in the table
  #checkov:skip=CKV_AWS_115:reserved concurrency fails on accounts with the default quota of 10
  #checkov:skip=CKV_AWS_116:the sender's failures go to the delivery queue's dead-letter queue, and the dispatcher's to the stream's
  #checkov:skip=CKV_AWS_117:calls destinations on the public internet and AWS APIs; a VPC would need a NAT gateway
  #checkov:skip=CKV_AWS_173:the environment holds parameter names, never secrets
  #checkov:skip=CKV_AWS_272:code signing is out of scope for v1
  for_each         = local.functions
  function_name    = "${var.name}-actions-${each.key}"
  role             = aws_iam_role.actions[each.key].arn
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.actions[each.key].output_path
  source_code_hash = data.archive_file.actions[each.key].output_base64sha256
  memory_size      = each.value.memory
  timeout          = each.value.timeout

  environment {
    variables = merge(
      {
        TABLE_NAME               = var.table_name
        DELIVERY_QUEUE_URL       = aws_sqs_queue.deliveries.url
        DELIVERY_DLQ_URL         = aws_sqs_queue.dead_letter.url
        ALLOWED_TARGET_ARNS      = join(",", var.allowed_target_arns)
        OUTBOUND_SECRET_PREFIXES = join(",", var.outbound_secret_prefixes)
        POWERTOOLS_LOG_LEVEL     = var.log_level
        NODE_OPTIONS             = "--enable-source-maps"
      },
      var.webhook_secret_parameter == null ? {} : { WEBHOOK_SECRET_PARAMETER = var.webhook_secret_parameter },
      var.telegram_token_parameter == null ? {} : { TELEGRAM_TOKEN_PARAMETER = var.telegram_token_parameter },
      var.ses_from_address == null ? {} : { SES_FROM_ADDRESS = var.ses_from_address },
      var.ses_configuration_set == null ? {} : { SES_CONFIGURATION_SET = var.ses_configuration_set },
      var.relayer_api_url == null ? {} : {
        RELAYER_API_URL           = var.relayer_api_url
        RELAYER_API_KEY_PARAMETER = var.relayer_api_key_parameter
      },
    )
  }

  depends_on = [aws_cloudwatch_log_group.actions, aws_iam_role_policy.dispatcher, aws_iam_role_policy.sender]
}

resource "aws_lambda_event_source_mapping" "stream" {
  event_source_arn = var.table_stream_arn
  function_name    = aws_lambda_function.actions["dispatcher"].arn
  # TRIM_HORIZON, not LATEST: Lambda takes minutes to start polling, and LATEST loses everything written in between
  starting_position = "TRIM_HORIZON"
  batch_size        = 50
  # a poison record must not hold the shard for the stream's whole 24 hours
  maximum_retry_attempts         = 3
  bisect_batch_on_function_error = true
  maximum_record_age_in_seconds  = 3600
  function_response_types        = ["ReportBatchItemFailures"]

  # its own queue, not the delivery dead-letter queue: a discarded batch was never written as a delivery, so
  # there is nothing for the redrive script to reset and send again
  destination_config {
    on_failure {
      destination_arn = aws_sqs_queue.stream_failures.arn
    }
  }

  # cursors, leases, spend counters and the dispatcher's own delivery items all share this table; only items
  # with SK = META can be a match or a transaction
  filter_criteria {
    filter {
      pattern = jsonencode({ dynamodb = { Keys = { SK = { S = ["META"] } } } })
    }
  }
}

resource "aws_lambda_event_source_mapping" "outbound" {
  count                   = var.outbound_queue ? 1 : 0
  event_source_arn        = aws_sqs_queue.outbound[0].arn
  function_name           = aws_lambda_function.actions["dispatcher"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "deliveries" {
  event_source_arn        = aws_sqs_queue.deliveries.arn
  function_name           = aws_lambda_function.actions["sender"].arn
  batch_size              = 10
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_function_event_invoke_config" "dispatcher" {
  # the schedule runs again next minute; Lambda's own async retries would overlap it
  function_name                = aws_lambda_function.actions["dispatcher"].function_name
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
  name               = "${var.name}-actions-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.actions["dispatcher"].arn]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-dispatcher"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "reaper" {
  #checkov:skip=CKV_AWS_297:a schedule only holds a function ARN; a customer managed key adds a fixed monthly cost
  name                = "${var.name}-actions-reaper"
  schedule_expression = var.schedule_expression

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.actions["dispatcher"].arn
    role_arn = aws_iam_role.scheduler.arn
    # an empty payload is what the handler reads as the sweep
    input = jsonencode({ source = "aws.scheduler" })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

resource "aws_sesv2_email_identity" "sender" {
  count          = var.ses_from_address != null && var.ses_verify_identity ? 1 : 0
  email_identity = var.ses_from_address
}
