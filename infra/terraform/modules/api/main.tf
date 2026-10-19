data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

data "aws_partition" "current" {}

data "aws_kms_alias" "ssm" {
  name = "alias/aws/ssm"
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.region

  # services/api/src/routes.ts ROUTES must list the same keys, and its PUBLIC_ROUTES exactly the ones marked
  # public here; a unit test there reads this file. A public route is one the authorizer does not stand in
  # front of, which only the three that hand out or clear a session can be.
  routes = {
    nonce          = { route_key = "POST /v1/auth/siwe/nonce", public = true }
    verify         = { route_key = "POST /v1/auth/siwe/verify", public = true }
    logout         = { route_key = "POST /v1/auth/logout", public = true }
    listRules      = { route_key = "GET /v1/rules", public = false }
    createRule     = { route_key = "POST /v1/rules", public = false }
    getRule        = { route_key = "GET /v1/rules/{ruleId}", public = false }
    patchRule      = { route_key = "PATCH /v1/rules/{ruleId}", public = false }
    deleteRule     = { route_key = "DELETE /v1/rules/{ruleId}", public = false }
    listMatches    = { route_key = "GET /v1/matches", public = false }
    listDeliveries = { route_key = "GET /v1/deliveries", public = false }
    redrive        = { route_key = "POST /v1/deliveries/{deliveryId}/redrive", public = false }
    listSigners    = { route_key = "GET /v1/relayer/signers", public = false }
    getTx          = { route_key = "GET /v1/relayer/txs/{txId}", public = false }
    listTxs        = { route_key = "GET /v1/relayer/txs", public = false }
    health         = { route_key = "GET /v1/health", public = false }
  }

  # A contract wallet's login waits out one RPC_TIMEOUT_MS (services/api/src/lambda/runtime.ts) per URL, with no
  # retries, for up to MAX_RPC_URLS (src/config.ts) URLs, then writes the session to DynamoDB. The route timeout
  # holds that with room to spare and stays under the integration timeout below, so a slow login is answered by
  # the function and not cut off by API Gateway.
  functions = {
    api        = { timeout = 15, memory = 256 }
    authorizer = { timeout = 10, memory = 256 }
  }

  # the shape src/config.ts parses from CHAINS
  chains_env = jsonencode([for c in var.chains : {
    chainId          = c.chain_id
    rpcUrlsParameter = c.rpc_urls_parameter
  }])

  rpc_parameter_arns = [for c in var.chains : "arn:${data.aws_partition.current.partition}:ssm:${local.region}:${local.account_id}:parameter${c.rpc_urls_parameter}"]

  # the parameter's name, never its value: each function reads the secret itself at cold start
  function_env = {
    api = {
      TABLE_NAME               = var.table.name
      SESSION_SECRET_PARAMETER = aws_ssm_parameter.session_secret.name
      DELIVERY_QUEUE_URL       = var.queues.delivery.url
      DELIVERY_DLQ_URL         = var.queues.dead_letter.url
      STREAM_FAILURE_QUEUE_URL = var.queues.stream_failure.url
      SITE_ORIGIN              = local.site_origin
      SIWE_DOMAIN              = local.siwe_domain
      ALLOWED_WALLETS          = join(",", var.allowed_wallets)
      CHAINS                   = local.chains_env
      RULE_SECRET_PREFIXES     = join(",", var.rule_secret_prefixes)
      NODE_OPTIONS             = "--enable-source-maps"
    }
    authorizer = {
      TABLE_NAME               = var.table.name
      SESSION_SECRET_PARAMETER = aws_ssm_parameter.session_secret.name
      NODE_OPTIONS             = "--enable-source-maps"
    }
  }

  function_roles = {
    api        = aws_iam_role.api.arn
    authorizer = aws_iam_role.authorizer.arn
  }
}

# The session secret. Its value is in Terraform state, as the relayer's API keys are. ignore_changes lets it be
# rotated with put-parameter without the next apply putting the old one back.
resource "random_password" "session_secret" {
  # sessionSecretFrom refuses fewer than 32 bytes; twice that leaves the HMAC key well clear of the floor
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "session_secret" {
  #checkov:skip=CKV_AWS_337:the default aws/ssm key encrypts it; a customer managed key adds a fixed monthly cost
  name  = "/${var.name}/api/session-secret"
  type  = "SecureString"
  value = random_password.session_secret.result

  lifecycle {
    ignore_changes = [value]
  }
}

data "archive_file" "api" {
  for_each    = local.functions
  type        = "zip"
  source_dir  = "${var.api_source_dir}/${each.key}"
  output_path = "${path.root}/.build/api-${each.key}.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  #checkov:skip=CKV_AWS_158:operational logs only; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough to investigate a request; the records it reads stay in the table
  for_each          = local.functions
  name              = "/aws/lambda/${var.name}-${each.key}"
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

resource "aws_iam_role" "api" {
  name               = "${var.name}-api"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "authorizer" {
  name               = "${var.name}-authorizer"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# No Scan: every route is a GetItem or a Query, which is why the listings refuse a status no index serves. A route
# that needs a Scan needs that decision revisited, not a wider grant here. No kms:Sign, kms:GetPublicKey, ses:* or
# lambda:InvokeFunction either: a session reads the relayer's records and never signs or sends.
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "Table"
    actions   = ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem"]
    resources = [var.table.arn]
  }

  statement {
    sid       = "TableIndexes"
    actions   = ["dynamodb:Query"]
    resources = ["${var.table.arn}/index/GSI1", "${var.table.arn}/index/GSI2"]
  }

  statement {
    sid       = "SessionSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.session_secret.arn]
  }

  # a contract wallet's login is verified against the chain it signed for
  statement {
    sid       = "RpcUrls"
    actions   = ["ssm:GetParameter"]
    resources = local.rpc_parameter_arns
  }

  statement {
    sid       = "DecryptParameters"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.ssm.target_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "Redrive"
    actions   = ["sqs:SendMessage"]
    resources = [var.queues.delivery.arn]
  }

  statement {
    sid       = "QueueDepth"
    actions   = ["sqs:GetQueueAttributes"]
    resources = [var.queues.delivery.arn, var.queues.dead_letter.arn, var.queues.stream_failure.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api["api"].arn}:*"]
  }
}

# it reads one API key row and verifies one token, and stands in front of every request, so it can do nothing else
data "aws_iam_policy_document" "authorizer" {
  statement {
    sid       = "ApiKeys"
    actions   = ["dynamodb:GetItem"]
    resources = [var.table.arn]
  }

  statement {
    sid       = "SessionSecret"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.session_secret.arn]
  }

  statement {
    sid       = "DecryptSessionSecret"
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
    resources = ["${aws_cloudwatch_log_group.api["authorizer"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy" "authorizer" {
  name   = "authorizer"
  role   = aws_iam_role.authorizer.id
  policy = data.aws_iam_policy_document.authorizer.json
}

resource "aws_lambda_function" "api" {
  #checkov:skip=CKV_AWS_50:tracing is not needed; the access log and each function's own log cover a request
  #checkov:skip=CKV_AWS_115:reserved concurrency fails on accounts with the default quota of 10; the stage throttles instead
  #checkov:skip=CKV_AWS_116:both are invoked synchronously by API Gateway, so there is no event to dead-letter
  #checkov:skip=CKV_AWS_117:only calls public RPC endpoints and AWS APIs; a VPC would need a NAT gateway
  #checkov:skip=CKV_AWS_173:the environment holds no secrets; the session secret and RPC URLs are read from SSM at runtime
  #checkov:skip=CKV_AWS_272:code signing is out of scope for v1
  for_each         = local.functions
  function_name    = "${var.name}-${each.key}"
  role             = local.function_roles[each.key]
  runtime          = "nodejs24.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.api[each.key].output_path
  source_code_hash = data.archive_file.api[each.key].output_base64sha256
  memory_size      = each.value.memory
  timeout          = each.value.timeout

  environment {
    variables = local.function_env[each.key]
  }

  depends_on = [aws_cloudwatch_log_group.api, aws_iam_role_policy.api, aws_iam_role_policy.authorizer]
}

resource "aws_apigatewayv2_api" "api" {
  name          = "${var.name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api["api"].invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_authorizer" "session" {
  api_id                            = aws_apigatewayv2_api.api.id
  name                              = "${var.name}-session"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = aws_lambda_function.api["authorizer"].invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  # A cached answer would be keyed on the cookie and keep admitting a session after logout, so every request asks.
  # With no cache there is no identity source either: API Gateway answers 401 itself when a named source is
  # missing, and a caller brings a cookie or a bearer key, never both.
  authorizer_result_ttl_in_seconds = 0
}

resource "aws_apigatewayv2_route" "api" {
  #checkov:skip=CKV_AWS_309:the three auth routes are public so a caller can get a session; every other route has the authorizer
  for_each           = local.routes
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = each.value.route_key
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = each.value.public ? "NONE" : "CUSTOM"
  authorizer_id      = each.value.public ? null : aws_apigatewayv2_authorizer.session.id
}

resource "aws_cloudwatch_log_group" "api_access" {
  #checkov:skip=CKV_AWS_158:access logs hold no secrets; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough to investigate a request
  name              = "/aws/apigateway/${var.name}-api"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttle.burst_limit
    throttling_rate_limit  = var.api_throttle.rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    # no headers, so neither the session cookie nor the Authorization header reaches the log
    format = jsonencode({
      requestId       = "$context.requestId"
      time            = "$context.requestTime"
      routeKey        = "$context.routeKey"
      status          = "$context.status"
      latency         = "$context.integrationLatency"
      authorizerError = "$context.authorizer.error"
      ip              = "$context.identity.sourceIp"
    })
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api["api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowApiGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api["authorizer"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.session.id}"
}

# the route handler turns its own failures into 500 responses, so they never count as Lambda errors
resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "The API is answering with server errors."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.api.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}

# a cold start that cannot load its settings or read its secrets, a timeout, and the authorizer's rethrown lookup
# failure are what reach these
resource "aws_cloudwatch_metric_alarm" "errors" {
  for_each            = local.functions
  alarm_name          = "${var.name}-${each.key}-errors"
  alarm_description   = "The ${each.key} function is throwing."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = aws_lambda_function.api[each.key].function_name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [var.alarm_topic_arn]
  ok_actions          = [var.alarm_topic_arn]
}
