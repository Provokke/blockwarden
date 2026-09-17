resource "aws_sns_topic" "alarms" {
  #checkov:skip=CKV_AWS_26:alarm notifications carry no secrets, and CloudWatch cannot publish to a topic encrypted with the AWS managed SNS key
  count = var.alarm_topic_arn == null ? 1 : 0
  name  = "${var.name}-relayer-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_topic_arn == null && var.alarm_email != null ? 1 : 0
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  signer_balance_alarms = merge([for id, s in var.signers : {
    for chain_id in s.chain_ids : "${id}-${chain_id}" => { signer_id = id, chain_id = chain_id, gwei = s.balance_alarm_gwei }
  } if s.balance_alarm_gwei != null]...)
}

# a paused signer, a fee cap below the replacement minimum and a stuck nonce all leave a transaction unsettled
resource "aws_cloudwatch_metric_alarm" "pending_age" {
  for_each            = var.chains
  alarm_name          = "${var.name}-relayer-${each.key}-pending-age"
  alarm_description   = "A relayed transaction on ${each.key} has been unsettled for more than ${var.pending_age_alarm_seconds} seconds."
  namespace           = "Blockwarden"
  metric_name         = "pendingAgeSeconds"
  dimensions          = { service = "relayer", chainId = tostring(each.value.chain_id) }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.pending_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alarm_topic_arn]
  ok_actions          = [local.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "signer_balance" {
  for_each            = local.signer_balance_alarms
  alarm_name          = "${var.name}-relayer-${each.key}-balance"
  alarm_description   = "Signer ${each.value.signer_id} holds less than ${each.value.gwei} gwei on chain ${each.value.chain_id}."
  namespace           = "Blockwarden"
  metric_name         = "signerBalanceGwei"
  dimensions          = { service = "relayer", chainId = tostring(each.value.chain_id), signerId = each.value.signer_id }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = each.value.gwei
  comparison_operator = "LessThanThreshold"
  # a sweeper that stops reporting trips its own error alarm
  treat_missing_data = "notBreaching"
  alarm_actions      = [local.alarm_topic_arn]
  ok_actions         = [local.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = local.functions
  alarm_name          = "${var.name}-relayer-${each.key}-errors"
  alarm_description   = "The relayer ${each.key} function is throwing."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.relayer[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alarm_topic_arn]
}

# the API handler turns its own failures into 500 responses, so they never count as Lambda errors
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-relayer-api-5xx"
  alarm_description   = "The relayer API is answering with server errors."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.relayer.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alarm_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name          = "${var.name}-relayer-dead-letters"
  alarm_description   = "Signer messages failed five times and reached the dead-letter queue."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dead_letter.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [local.alarm_topic_arn]
}
