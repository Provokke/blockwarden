locals {
  # services/relayer/src/api.ts ROUTES must list the same keys; a unit test there reads this file
  routes = [
    "POST /v1/relayer/txs",
    "GET /v1/relayer/txs/{txId}",
    "GET /v1/relayer/signers",
  ]
}

resource "aws_apigatewayv2_api" "relayer" {
  name          = "${var.name}-relayer"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.relayer.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.relayer["api"].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "relayer" {
  #checkov:skip=CKV_AWS_309:the handler checks the API key on every route; the SIWE authorizer arrives in milestone 4
  for_each  = toset(local.routes)
  api_id    = aws_apigatewayv2_api.relayer.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_cloudwatch_log_group" "api_access" {
  #checkov:skip=CKV_AWS_158:access logs hold no secrets; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV_AWS_338:two weeks is enough to investigate a request
  name              = "/aws/apigateway/${var.name}-relayer"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.relayer.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttle.burst_limit
    throttling_rate_limit  = var.api_throttle.rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    # no headers, so the Authorization header never reaches the log
    format = jsonencode({
      requestId = "$context.requestId"
      time      = "$context.requestTime"
      routeKey  = "$context.routeKey"
      status    = "$context.status"
      latency   = "$context.integrationLatency"
      ip        = "$context.identity.sourceIp"
    })
  }
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.relayer["api"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.relayer.execution_arn}/*/*"
}
