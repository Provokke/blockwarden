resource "aws_sqs_queue" "dead_letter" {
  name                      = "${var.name}-deliveries-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "deliveries" {
  name = "${var.name}-deliveries"
  # six times the sender timeout, as Lambda recommends for an SQS event source
  visibility_timeout_seconds = 180
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  # the sender counts attempts on the delivery item and dead-letters there; this is only a poison-message backstop
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 5
  })
}

# where Lambda puts a stream batch it gave up on. Kept apart from the delivery dead-letter queue because the
# two need different work: a dead delivery is in the table and can be redriven, a discarded batch never got
# there and has to be read back out of the stream while it still exists.
resource "aws_sqs_queue" "stream_failures" {
  name                      = "${var.name}-stream-failures"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "outbound_dead_letter" {
  count                     = var.outbound_queue ? 1 : 0
  name                      = "${var.name}-outbound-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "outbound" {
  count                      = var.outbound_queue ? 1 : 0
  name                       = "${var.name}-outbound"
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  # a request the dispatcher cannot accept is reported back and lands here, where the caller can read it
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.outbound_dead_letter[0].arn
    maxReceiveCount     = 5
  })
}
