module "api" {
  count  = var.api == null ? 0 : 1
  source = "../api"

  name           = var.name
  api_source_dir = var.api.source_dir
  table          = { name = aws_dynamodb_table.main.name, arn = aws_dynamodb_table.main.arn }
  chains         = { for key, c in var.chains : key => { chain_id = c.chain_id, rpc_urls_parameter = c.rpc_urls_parameter } }

  queues = {
    delivery       = { url = module.actions[0].delivery_queue_url, arn = module.actions[0].delivery_queue_arn }
    dead_letter    = { url = module.actions[0].delivery_dead_letter_queue_url, arn = module.actions[0].delivery_dead_letter_queue_arn }
    stream_failure = { url = module.actions[0].stream_failure_queue_url, arn = module.actions[0].stream_failure_queue_arn }
  }

  allowed_wallets = var.api.allowed_wallets
  site_origin     = var.api.site_origin
  siwe_domain     = var.api.siwe_domain
  # the dispatcher's own list, so a rule the API accepts is one it will build deliveries for
  rule_secret_prefixes = var.actions.rule_secret_prefixes

  alarm_topic_arn    = aws_sns_topic.alarms.arn
  log_retention_days = var.log_retention_days
}
