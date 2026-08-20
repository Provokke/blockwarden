resource "aws_sns_topic" "alarms" {
  #checkov:skip=CKV_AWS_26:alarm notifications carry no secrets, and CloudWatch cannot publish to a topic encrypted with the AWS managed SNS key
  name = "${var.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# a busy run publishes no durableLag, so sustained busy runs also look like missing data and breach this alarm
resource "aws_cloudwatch_metric_alarm" "durable_lag" {
  for_each            = var.chains
  alarm_name          = "${var.name}-monitor-${each.key}-durable-lag"
  alarm_description   = "Durable scan for ${each.key} is more than ${each.value.lag_alarm_blocks} blocks behind the finalized block, or has stopped reporting."
  namespace           = "Blockwarden"
  metric_name         = "durableLag"
  dimensions          = { service = "monitor", chainId = tostring(each.value.chain_id) }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = each.value.lag_alarm_blocks
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "finalized_age" {
  for_each            = var.chains
  alarm_name          = "${var.name}-monitor-${each.key}-finalized-age"
  alarm_description   = "The RPC for ${each.key} reports a finalized block more than an hour old, so final records are delayed."
  namespace           = "Blockwarden"
  metric_name         = "finalizedAgeSeconds"
  dimensions          = { service = "monitor", chainId = tostring(each.value.chain_id) }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = var.chains
  alarm_name          = "${var.name}-monitor-${each.key}-errors"
  alarm_description   = "Monitor for ${each.key} is throwing."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.monitor[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
