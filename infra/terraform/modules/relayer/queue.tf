resource "aws_sqs_queue" "dead_letter" {
  name                      = "${var.name}-relayer-txs-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "txs" {
  name       = "${var.name}-relayer-txs.fifo"
  fifo_queue = true
  # the API sets a deduplication id per enqueue, so a body-hash id would drop the sweeper's requeues
  content_based_deduplication = false
  # six times the signer timeout, as Lambda recommends for an SQS event source
  visibility_timeout_seconds = 360
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  # a message that keeps failing unblocks its signer's group here; the transaction stays queued in the table
  # and the sweeper sends it again later
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letter.arn
    maxReceiveCount     = 5
  })
}
