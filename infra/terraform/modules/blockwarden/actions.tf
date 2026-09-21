module "actions" {
  count  = var.actions == null ? 0 : 1
  source = "../actions"

  name                      = var.name
  actions_source_dir        = var.actions.source_dir
  table_name                = aws_dynamodb_table.main.name
  table_arn                 = aws_dynamodb_table.main.arn
  table_stream_arn          = aws_dynamodb_table.main.stream_arn
  alarm_topic_arn           = aws_sns_topic.alarms.arn
  webhook_secret_parameter  = var.actions.webhook_secret_parameter
  telegram_token_parameter  = var.actions.telegram_token_parameter
  ses_from_address          = var.actions.ses_from_address
  ses_verify_identity       = var.actions.ses_verify_identity
  ses_configuration_set     = var.actions.ses_configuration_set
  relayer_api_url           = var.actions.relayer_api_url
  relayer_api_key_parameter = var.actions.relayer_api_key_parameter
  allowed_target_arns       = var.actions.allowed_target_arns
  outbound_queue            = var.actions.outbound_queue
  outbound_secret_prefixes  = var.actions.outbound_secret_prefixes
  rule_secret_prefixes      = var.actions.rule_secret_prefixes

  signer_webhook_secret_parameters = var.actions.signer_webhook_secret_parameters
  # the reaper runs on the same clock as the pollers it follows
  schedule_expression = var.schedule_expression
  log_level           = var.actions.log_level
  log_retention_days  = var.log_retention_days
}
