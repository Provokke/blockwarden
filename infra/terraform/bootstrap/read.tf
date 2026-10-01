# What terraform plan reads to refresh the staging and demo stacks: each resource type in the modules, and the
# calls the AWS provider (6.66) makes to read it back. The plan role has this and the state; each apply role has
# this and its own writes. Read-only, so it names both stacks at once through the blockwarden-* prefix.
locals {
  region_arn = "${local.partition}:%s:${var.region}:${local.account_id}"

  # every statement here allows; the merge in read_policy adds the Effect
  read_statements = [
    {
      Sid = "Buckets"
      Action = [
        "s3:GetAccelerateConfiguration", "s3:GetBucketAcl", "s3:GetBucketCORS", "s3:GetBucketLogging",
        "s3:GetBucketObjectLockConfiguration", "s3:GetBucketOwnershipControls", "s3:GetBucketPolicy",
        "s3:GetBucketPublicAccessBlock", "s3:GetBucketRequestPayment", "s3:GetBucketTagging",
        "s3:GetBucketVersioning", "s3:GetBucketWebsite", "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration", "s3:GetReplicationConfiguration", "s3:ListBucket",
      ]
      Resource = ["arn:${local.partition}:s3:::blockwarden-*"]
    },
    {
      Sid      = "Tables"
      Action   = ["dynamodb:DescribeContinuousBackups", "dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive", "dynamodb:ListTagsOfResource"]
      Resource = ["arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-*"]
    },
    {
      # GetItem is for the rule, signer and API key items Terraform writes. The leading-key condition limits it to
      # the partitions Terraform writes, and IAM cannot condition on a sort key. The relayer also keeps its nonce,
      # pause and spend rows inside signer partitions, and those stay readable; match, delivery and the other
      # runtime data is not.
      Sid    = "TerraformItems"
      Action = ["dynamodb:GetItem"]
      Resource = [
        "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-staging",
        "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-demo",
      ]
      Condition = {
        "ForAllValues:StringLike" = { "dynamodb:LeadingKeys" = ["RULE#*", "SIGNER#*", "APIKEY#*"] }
      }
    },
    {
      Sid      = "Roles"
      Action   = ["iam:GetRole", "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole", "iam:ListRolePolicies", "iam:ListRoleTags"]
      Resource = ["arn:${local.partition}:iam::${local.account_id}:role/blockwarden-*"]
    },
    {
      Sid = "Functions"
      Action = [
        "lambda:GetFunction", "lambda:GetFunctionCodeSigningConfig", "lambda:GetFunctionConcurrency",
        "lambda:GetFunctionConfiguration", "lambda:GetFunctionEventInvokeConfig", "lambda:GetPolicy",
        "lambda:ListTags", "lambda:ListVersionsByFunction",
      ]
      Resource = ["arn:${format(local.region_arn, "lambda")}:function:blockwarden-*"]
    },
    {
      # a mapping's ARN ends in a UUID Lambda chooses, so it cannot carry the stack's name
      Sid      = "EventSourceMappings"
      Action   = ["lambda:GetEventSourceMapping", "lambda:ListTags"]
      Resource = ["arn:${format(local.region_arn, "lambda")}:event-source-mapping:*"]
    },
    {
      Sid      = "Schedules"
      Action   = ["scheduler:GetSchedule"]
      Resource = ["arn:${format(local.region_arn, "scheduler")}:schedule/default/blockwarden-*"]
    },
    {
      Sid      = "Queues"
      Action   = ["sqs:GetQueueAttributes", "sqs:ListQueueTags"]
      Resource = ["arn:${format(local.region_arn, "sqs")}:blockwarden-*"]
    },
    {
      # a subscription's ARN is its topic's ARN and a UUID, so the topic prefix covers both
      Sid      = "Topics"
      Action   = ["sns:GetSubscriptionAttributes", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic", "sns:ListTagsForResource"]
      Resource = ["arn:${format(local.region_arn, "sns")}:blockwarden-*"]
    },
    {
      Sid    = "LogGroupTags"
      Action = ["logs:ListTagsForResource"]
      Resource = [
        "arn:${format(local.region_arn, "logs")}:log-group:/aws/lambda/blockwarden-*",
        "arn:${format(local.region_arn, "logs")}:log-group:/aws/apigateway/blockwarden-*",
      ]
    },
    {
      Sid      = "AlarmTags"
      Action   = ["cloudwatch:ListTagsForResource"]
      Resource = ["arn:${format(local.region_arn, "cloudwatch")}:alarm:blockwarden-*"]
    },
    {
      # Key ids are random, and the aws/ssm key the modules look up carries no tag of ours, so these name every
      # key in the account. None of them reads key material or signs.
      Sid      = "Keys"
      Action   = ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:ListResourceTags"]
      Resource = ["arn:${format(local.region_arn, "kms")}:key/*"]
    },
    {
      # Only the two kinds of SecureString Terraform itself writes, whose values are already in the state this
      # role reads. The provider decrypts every SecureString it refreshes. The owner's own parameters, the RPC URLs
      # and the webhook secret, are never read by Terraform and are not named here.
      Sid    = "TerraformParameters"
      Action = ["ssm:GetParameter"]
      Resource = [
        "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-staging/api/session-secret",
        "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-demo/api/session-secret",
        "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-staging/relayer/api-keys/*",
        "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-demo/relayer/api-keys/*",
      ]
    },
    {
      Sid      = "ParameterTags"
      Action   = ["ssm:ListTagsForResource"]
      Resource = ["arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-*"]
    },
    {
      # an API's id is chosen by API Gateway, so the paths cannot carry the stack's name
      Sid    = "HttpApis"
      Action = ["apigateway:GET"]
      Resource = [
        "arn:${local.partition}:apigateway:${var.region}::/apis",
        "arn:${local.partition}:apigateway:${var.region}::/apis/*",
        "arn:${local.partition}:apigateway:${var.region}::/tags/*",
      ]
    },
    {
      # distribution, policy and origin access control ids are chosen by CloudFront; only a function has a name
      Sid    = "CloudFront"
      Action = ["cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:GetInvalidation", "cloudfront:GetOriginAccessControl", "cloudfront:GetResponseHeadersPolicy", "cloudfront:GetCachePolicy", "cloudfront:GetOriginRequestPolicy", "cloudfront:ListTagsForResource"]
      Resource = [
        "arn:${local.partition}:cloudfront::${local.account_id}:distribution/*",
        "arn:${local.partition}:cloudfront::${local.account_id}:origin-access-control/*",
        "arn:${local.partition}:cloudfront::${local.account_id}:response-headers-policy/*",
        "arn:${local.partition}:cloudfront::${local.account_id}:cache-policy/*",
        "arn:${local.partition}:cloudfront::${local.account_id}:origin-request-policy/*",
      ]
    },
    {
      Sid      = "CloudFrontFunctions"
      Action   = ["cloudfront:DescribeFunction", "cloudfront:GetFunction"]
      Resource = ["arn:${local.partition}:cloudfront::${local.account_id}:function/blockwarden-*"]
    },
    {
      # the optional custom domain's certificate, which CloudFront takes from us-east-1 only
      Sid      = "Certificates"
      Action   = ["acm:DescribeCertificate", "acm:ListTagsForCertificate"]
      Resource = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]
    },
    {
      # These list or describe across the account and take no resource ARN: the managed cache and origin request
      # policies the site looks up by name, the alias lookup for aws/ssm, the log group and alarm descriptions,
      # and the parameter metadata, which never includes a value.
      Sid = "AccountWideReads"
      Action = [
        "cloudfront:ListCachePolicies", "cloudfront:ListOriginRequestPolicies", "cloudwatch:DescribeAlarms",
        "kms:ListAliases", "logs:DescribeLogGroups", "ssm:DescribeParameters",
      ]
      Resource = ["*"]
    },
  ]

  read_policy = {
    Version   = "2012-10-17"
    Statement = [for s in local.read_statements : merge({ Effect = "Allow" }, s)]
  }
}

resource "aws_iam_policy" "read" {
  name        = "blockwarden-read"
  description = "What terraform plan reads to refresh the Blockwarden stacks."
  policy      = jsonencode(local.read_policy)
}
