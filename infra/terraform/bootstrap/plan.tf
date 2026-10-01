resource "aws_iam_role" "plan" {
  name                 = "blockwarden-plan"
  description          = "terraform plan for the Blockwarden stacks, from pull requests and main."
  assume_role_policy   = jsonencode(local.trust_policies["plan"])
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "plan_read" {
  role       = aws_iam_role.plan.name
  policy_arn = aws_iam_policy.read.arn
}

locals {
  # A plan takes the lock, so it writes and deletes the lock file and nothing else. It reads both states.
  plan_state_policy = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListState"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [local.state_bucket_arn]
      },
      {
        Sid      = "ReadState"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${local.state_bucket_arn}/*"]
      },
      {
        Sid      = "Lock"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = ["${local.state_bucket_arn}/*.tflock"]
      },
    ]
  }
}

resource "aws_iam_role_policy" "plan_state" {
  name   = "state"
  role   = aws_iam_role.plan.id
  policy = jsonencode(local.plan_state_policy)
}
