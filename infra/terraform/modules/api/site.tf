# The dashboard and the API behind one distribution. The session cookie is SameSite=Strict and has no Domain, so a
# browser sends it only to the host that set it, and only from a page on the same site. One host for both meets
# that; the API's own execute-api name, a different site from any dashboard, would make every request after
# sign-in a 401.

locals {
  site_origin = var.site_origin != null ? var.site_origin : "https://${aws_cloudfront_distribution.site.domain_name}"
  siwe_domain = var.siwe_domain != null ? var.siwe_domain : trimprefix(local.site_origin, "https://")

  # Next's app router inlines its bootstrap and flight data into every page, and the flight data changes with each
  # build, so the hashes come from the export being uploaded (apps/dashboard/scripts/csp-hashes.mjs) and not from
  # this file. 'unsafe-inline' would admit any script an injected tag carried.
  script_src = join(" ", concat(["'self'"], [for h in var.site_script_hashes : "'${h}'"]))

  # The script measures the length of this string against CloudFront's limit on it, so its list of directives
  # has to match this one; a test compares them.
  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src ${local.script_src}",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ])
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# CloudFront strips Cookie and Authorization before the origin unless a policy forwards them, and every
# authenticated request would then reach the authorizer with neither. The viewer's Host is the one header left
# out, because API Gateway routes on its own host name.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_s3_bucket" "site" {
  #checkov:skip=CKV_AWS_144:the export is rebuilt from source, so a second region's copy protects nothing
  #checkov:skip=CKV_AWS_145:SSE-S3 is enough for a public page's files; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV2_AWS_62:nothing consumes the bucket's events
  bucket_prefix = "${lower(var.name)}-site-"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

# a sync with --delete leaves the previous export behind as noncurrent versions, which is the rollback; a month of
# them is enough to notice a bad deploy
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    id     = "previous-exports"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.site]
}

resource "aws_s3_bucket_logging" "site" {
  bucket        = aws_s3_bucket.site.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/site/"
}

# Only this distribution may read. A statement naming the CloudFront service principal without the SourceArn
# condition lets every distribution in every account read the bucket.
data "aws_iam_policy_document" "site" {
  statement {
    sid       = "ThisDistributionReads"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }

  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.site.arn, "${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# The distribution's standard log and the site bucket's access log. CloudFront's standard logging writes through
# a bucket ACL grant it adds itself when the distribution is created, so this bucket keeps ACLs enabled.
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_18:this is the log bucket; logging its own access would need another bucket, and so on
  #checkov:skip=CKV_AWS_21:logs expire after 30 days, and versioning would only keep an expired log longer
  #checkov:skip=CKV_AWS_144:the logs are disposable, so a second region's copy protects nothing
  #checkov:skip=CKV_AWS_145:SSE-S3 is enough for request logs; a customer managed key adds a fixed monthly cost
  #checkov:skip=CKV2_AWS_62:nothing consumes the bucket's events
  bucket_prefix = "${lower(var.name)}-logs-"
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  #checkov:skip=CKV2_AWS_65:CloudFront standard logging delivers through an ACL grant, so ACLs have to stay enabled
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire"
    status = "Enabled"
    filter {}

    expiration {
      days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "SiteAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/s3/site/*"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.site.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.logs.arn, "${aws_s3_bucket.logs.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json

  depends_on = [aws_s3_bucket_public_access_block.logs]
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_function" "site_rewrite" {
  name    = "${var.name}-site-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = file("${path.module}/site-rewrite.js")
}

resource "aws_cloudfront_response_headers_policy" "site" {
  name = "${var.name}-site"

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "same-origin"
      override        = true
    }

    # includeSubDomains reaches only names under the dashboard's own host, and preload does nothing until the
    # domain is submitted to the browsers' preload list
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  #checkov:skip=CKV_AWS_68:no WAF, on cost grounds: see Non-goals in the design's Scope section
  #checkov:skip=CKV2_AWS_47:no WAF, on cost grounds: see Non-goals in the design's Scope section
  #checkov:skip=CKV_AWS_174:the default *.cloudfront.net certificate fixes the minimum protocol; a custom domain and its certificate come with the public demo
  #checkov:skip=CKV2_AWS_42:the default *.cloudfront.net certificate until the public demo's custom domain
  #checkov:skip=CKV_AWS_310:each path has one origin, and a second copy of either would be a second deployment
  #checkov:skip=CKV_AWS_374:the dashboard is not restricted by country
  enabled             = true
  comment             = "${var.name} dashboard and API"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  # the $default stage answers at the API's own host with no stage path
  origin {
    origin_id   = "api"
    domain_name = trimprefix(aws_apigatewayv2_api.api.api_endpoint, "https://")

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    compress                   = true

    # Here and not on the distribution's custom error responses, which would apply to /v1/* as well and answer an
    # API 404 with a page.
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.site_rewrite.arn
    }
  }

  # https-only rather than a redirect: a browser follows a 301 on a POST with a GET, which would reach a
  # different route
  ordered_cache_behavior {
    path_pattern               = "/v1/*"
    target_origin_id           = "api"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  # no cookies: the session cookie is a bearer credential and would otherwise be written to every log line
  logging_config {
    bucket          = aws_s3_bucket.logs.bucket_domain_name
    prefix          = "cloudfront/"
    include_cookies = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  depends_on = [aws_s3_bucket_ownership_controls.logs, aws_s3_bucket_policy.logs]
}
