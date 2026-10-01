# Terraform's own S3 lockfile does the locking (use_lockfile in each root's backend), so there is no lock table.
resource "aws_s3_bucket" "state" {
  #checkov:skip=CKV_AWS_18:an access log needs a second bucket; the only writers are the three roles below, and CloudTrail records every time one is assumed
  #checkov:skip=CKV_AWS_144:versioning keeps every earlier state in the region the stacks run in; a second region's copy would not outlive them
  #checkov:skip=CKV_AWS_145:SSE-S3 rather than SSE-KMS: a customer managed key costs $1 a month and protects nothing more here
  #checkov:skip=CKV2_AWS_62:nothing consumes the bucket's events
  bucket = local.state_bucket

  # every stack's state is in here, and losing it orphans everything those stacks created
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}

# every apply writes a new version; 90 days of them is enough to recover from a bad apply that was noticed late
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "previous-states"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "TlsOnly"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.state]
}
