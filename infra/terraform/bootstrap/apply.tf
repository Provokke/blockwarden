# One apply role per stack, each trusted only from its own GitHub environment. Its writes are what the modules'
# resource types need to be created, updated, tagged and deleted, from the provider's own calls (6.66), scoped to
# the stack's names wherever the service lets a name into the ARN, and otherwise to its environment tag. Its reads
# are its own stack's read policy.
#
# This list is derived, not proven. Only a real apply can prove an IAM policy complete, and the first one is
# milestone 5c's.
locals {
  apply_policies = { for env in local.environments : env => {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "ListState"
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = [local.state_bucket_arn]
        Condition = { StringLike = { "s3:prefix" = ["${env}/*"] } }
      },
      {
        Sid      = "OwnState"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${local.state_bucket_arn}/${env}/terraform.tfstate"]
      },
      {
        Sid      = "OwnLock"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
        Resource = ["${local.state_bucket_arn}/${env}/terraform.tfstate.tflock"]
      },
      {
        # the table is named exactly blockwarden-<env>, with no suffix
        Sid    = "Table"
        Effect = "Allow"
        Action = [
          "dynamodb:CreateTable", "dynamodb:DeleteItem", "dynamodb:DeleteTable", "dynamodb:PutItem",
          "dynamodb:TagResource", "dynamodb:UntagResource", "dynamodb:UpdateContinuousBackups",
          "dynamodb:UpdateItem", "dynamodb:UpdateTable", "dynamodb:UpdateTimeToLive",
        ]
        Resource = [
          "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-${env}",
          "arn:${format(local.region_arn, "dynamodb")}:table/blockwarden-${env}/*",
        ]
      },
      {
        # a role can be created, or given an inline policy, only with this stack's boundary attached
        Sid       = "BoundedRoles"
        Effect    = "Allow"
        Action    = ["iam:CreateRole", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy"]
        Resource  = ["arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-*"]
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.boundary[env].arn } }
      },
      {
        # These need no boundary condition on the assumption that every blockwarden-<env>-* role was created
        # through BoundedRoles, so carries the boundary and can be rewritten, tagged or deleted without raising its
        # ceiling. A role of that name made outside this policy would not be held by it.
        Sid    = "Roles"
        Effect = "Allow"
        Action = [
          "iam:DeleteRole", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy", "iam:UpdateRole",
          "iam:UpdateRoleDescription",
        ]
        Resource = ["arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-*"]
      },
      {
        Sid      = "PassRoles"
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = ["arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-*"]
        Condition = {
          StringEquals = { "iam:PassedToService" = ["lambda.amazonaws.com", "scheduler.amazonaws.com"] }
        }
      },
      {
        # Its own name matches the prefix above, so it is shut out of itself and of its boundary explicitly, and
        # no role may ever lose its boundary.
        Sid    = "NotItself"
        Effect = "Deny"
        Action = ["iam:*"]
        Resource = [
          "arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-apply",
          "arn:${local.partition}:iam::${local.account_id}:policy/blockwarden-${env}-boundary",
        ]
      },
      {
        Sid      = "KeepBoundaries"
        Effect   = "Deny"
        Action   = ["iam:DeleteRolePermissionsBoundary"]
        Resource = ["*"]
      },
      {
        Sid    = "Functions"
        Effect = "Allow"
        Action = [
          "lambda:AddPermission", "lambda:CreateFunction", "lambda:DeleteFunction",
          "lambda:DeleteFunctionEventInvokeConfig", "lambda:PutFunctionEventInvokeConfig", "lambda:RemovePermission",
          "lambda:TagResource", "lambda:UntagResource", "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration", "lambda:UpdateFunctionEventInvokeConfig",
        ]
        Resource = ["arn:${format(local.region_arn, "lambda")}:function:blockwarden-${env}-*"]
      },
      {
        # Mapping ids are chosen by Lambda. Create takes no resource ARN, so both are held to this stack's
        # functions by the function the mapping names.
        Sid       = "EventSourceMappings"
        Effect    = "Allow"
        Action    = ["lambda:CreateEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:UpdateEventSourceMapping"]
        Resource  = ["*"]
        Condition = { ArnLike = { "lambda:FunctionArn" = "arn:${format(local.region_arn, "lambda")}:function:blockwarden-${env}-*" } }
      },
      {
        # A mapping's id is chosen by Lambda and the tag actions carry no lambda:FunctionArn key, so they cannot be
        # held to the stack's functions. Tagging requires the stack's environment tag among the request's tags;
        # untagging requires the mapping to carry it. The mapping's own writes are held by the function above.
        Sid       = "EventSourceMappingTags"
        Effect    = "Allow"
        Action    = ["lambda:TagResource"]
        Resource  = ["arn:${format(local.region_arn, "lambda")}:event-source-mapping:*"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        Sid       = "EventSourceMappingUntags"
        Effect    = "Allow"
        Action    = ["lambda:UntagResource"]
        Resource  = ["arn:${format(local.region_arn, "lambda")}:event-source-mapping:*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        Sid      = "Schedules"
        Effect   = "Allow"
        Action   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:UpdateSchedule"]
        Resource = ["arn:${format(local.region_arn, "scheduler")}:schedule/default/blockwarden-${env}-*"]
      },
      {
        Sid      = "Queues"
        Effect   = "Allow"
        Action   = ["sqs:CreateQueue", "sqs:DeleteQueue", "sqs:SetQueueAttributes", "sqs:TagQueue", "sqs:UntagQueue"]
        Resource = ["arn:${format(local.region_arn, "sqs")}:blockwarden-${env}-*"]
      },
      {
        Sid    = "Topics"
        Effect = "Allow"
        Action = [
          "sns:CreateTopic", "sns:DeleteTopic", "sns:SetSubscriptionAttributes", "sns:SetTopicAttributes",
          "sns:Subscribe", "sns:TagResource", "sns:Unsubscribe", "sns:UntagResource",
        ]
        Resource = ["arn:${format(local.region_arn, "sns")}:blockwarden-${env}-*"]
      },
      {
        # CreateKey takes no resource ARN, and a key id is random, so a key belongs to this stack by the
        # environment tag the root's default_tags put on it
        Sid       = "CreateKeys"
        Effect    = "Allow"
        Action    = ["kms:CreateKey"]
        Resource  = ["*"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        Sid    = "Keys"
        Effect = "Allow"
        Action = [
          "kms:CreateAlias", "kms:DeleteAlias", "kms:DisableKey", "kms:EnableKey", "kms:PutKeyPolicy",
          "kms:ScheduleKeyDeletion", "kms:UntagResource", "kms:UpdateAlias", "kms:UpdateKeyDescription",
        ]
        Resource  = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        # a key can be tagged only with this stack's environment, so a stack cannot hand its key to the other
        Sid       = "KeyTags"
        Effect    = "Allow"
        Action    = ["kms:TagResource"]
        Resource  = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env, "aws:RequestTag/environment" = env } }
      },
      {
        # CreateKey with tags is also authorized as kms:TagResource, on a key that carries no tag yet. That is allowed
        # only while the key has no environment tag and the request sets this stack's, so a key already tagged for
        # the other stack is out of reach. An untagged key in the account is not.
        Sid      = "KeyCreateTags"
        Effect   = "Allow"
        Action   = ["kms:TagResource"]
        Resource = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = {
          StringEquals = { "aws:RequestTag/environment" = env }
          Null         = { "aws:ResourceTag/environment" = "true" }
        }
      },
      {
        Sid      = "Aliases"
        Effect   = "Allow"
        Action   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
        Resource = ["arn:${format(local.region_arn, "kms")}:alias/blockwarden-${env}-*"]
      },
      {
        # Only what Terraform writes: the session secret and module-made API keys. The RPC URLs and the webhook
        # secret under the same path are the owner's, and this role can neither read nor overwrite them.
        Sid    = "Parameters"
        Effect = "Allow"
        Action = ["ssm:AddTagsToResource", "ssm:DeleteParameter", "ssm:GetParameter", "ssm:PutParameter", "ssm:RemoveTagsFromResource"]
        Resource = [
          "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-${env}/api/*",
          "arn:${format(local.region_arn, "ssm")}:parameter/blockwarden-${env}/relayer/*",
        ]
      },
      {
        Sid    = "LogGroups"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:DeleteRetentionPolicy", "logs:PutRetentionPolicy",
          "logs:TagResource", "logs:UntagResource",
        ]
        Resource = [
          "arn:${format(local.region_arn, "logs")}:log-group:/aws/lambda/blockwarden-${env}-*",
          "arn:${format(local.region_arn, "logs")}:log-group:/aws/apigateway/blockwarden-${env}-*",
        ]
      },
      {
        # API Gateway sets up an HTTP API stage's access log through CloudWatch Logs' delivery API with the
        # caller's own credentials, and none of these actions takes a resource ARN
        Sid    = "AccessLogDelivery"
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery", "logs:DeleteLogDelivery", "logs:DescribeResourcePolicies",
          "logs:GetLogDelivery", "logs:ListLogDeliveries", "logs:PutResourcePolicy", "logs:UpdateLogDelivery",
        ]
        Resource = ["*"]
      },
      {
        Sid      = "Alarms"
        Effect   = "Allow"
        Action   = ["cloudwatch:DeleteAlarms", "cloudwatch:PutMetricAlarm", "cloudwatch:TagResource", "cloudwatch:UntagResource"]
        Resource = ["arn:${format(local.region_arn, "cloudwatch")}:alarm:blockwarden-${env}-*"]
      },
      {
        # An HTTP API's id is chosen by API Gateway, so a stack's APIs are told apart by the environment tag the
        # root's default_tags put on them: created only with it, and changed or deleted only while they carry it.
        Sid       = "CreateApis"
        Effect    = "Allow"
        Action    = ["apigateway:POST"]
        Resource  = ["arn:${local.partition}:apigateway:${var.region}::/apis"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        # routes, integrations, authorizers and stages are authorized by the tags of the API they sit under. Nothing
        # here writes /tags/*: that path has no resource-tag condition key, so a role that could would retag the
        # other stack's API as its own. Tags are set when an API is created, and changing them is the owner's.
        Sid       = "Apis"
        Effect    = "Allow"
        Action    = ["apigateway:DELETE", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"]
        Resource  = ["arn:${local.partition}:apigateway:${var.region}::/apis/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        # Bucket names come from bucket_prefix, so they carry the stack's name. GetBucketAcl and PutBucketAcl on
        # the log bucket are how CloudFront's standard logging grants itself write access, with the caller's
        # credentials. The object actions are the deploy's sync of the dashboard export.
        Sid    = "Buckets"
        Effect = "Allow"
        Action = [
          "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy", "s3:PutBucketAcl", "s3:PutBucketLogging",
          "s3:PutBucketOwnershipControls", "s3:PutBucketPolicy", "s3:PutBucketPublicAccessBlock",
          "s3:PutBucketTagging", "s3:PutBucketVersioning", "s3:PutEncryptionConfiguration",
          "s3:PutLifecycleConfiguration",
        ]
        Resource = [
          "arn:${local.partition}:s3:::blockwarden-${env}-site-*",
          "arn:${local.partition}:s3:::blockwarden-${env}-logs-*",
        ]
      },
      {
        Sid      = "SiteObjects"
        Effect   = "Allow"
        Action   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
        Resource = ["arn:${local.partition}:s3:::blockwarden-${env}-site-*/*"]
      },
      {
        # A distribution's id is chosen by CloudFront, so a stack's distributions are told apart by the environment
        # tag: created only with it, and changed, tagged or deleted only while they carry it. The provider creates
        # one with tags through CreateDistributionWithTags, which is no IAM action: the API needs
        # cloudfront:CreateDistribution, which takes no resource ARN, and cloudfront:TagResource, below.
        Sid       = "CreateDistributions"
        Effect    = "Allow"
        Action    = ["cloudfront:CreateDistribution"]
        Resource  = ["*"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        Sid    = "Distributions"
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation", "cloudfront:DeleteDistribution", "cloudfront:UntagResource",
          "cloudfront:UpdateDistribution",
        ]
        Resource  = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        Sid       = "DistributionTags"
        Effect    = "Allow"
        Action    = ["cloudfront:TagResource"]
        Resource  = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env, "aws:RequestTag/environment" = env } }
      },
      {
        # the TagResource half of a tagged create, on a distribution that carries no tag yet; see KeyCreateTags
        Sid      = "DistributionCreateTags"
        Effect   = "Allow"
        Action   = ["cloudfront:TagResource"]
        Resource = ["arn:${local.partition}:cloudfront::${local.account_id}:distribution/*"]
        Condition = {
          StringEquals = { "aws:RequestTag/environment" = env }
          Null         = { "aws:ResourceTag/environment" = "true" }
        }
      },
      {
        # Origin access controls and response headers policies take no tags and their ids are chosen by CloudFront,
        # so neither the name nor a tag can hold these to the stack. A stack can change the other's.
        Sid    = "EdgePolicies"
        Effect = "Allow"
        Action = [
          "cloudfront:DeleteOriginAccessControl", "cloudfront:DeleteResponseHeadersPolicy",
          "cloudfront:UpdateOriginAccessControl", "cloudfront:UpdateResponseHeadersPolicy",
        ]
        Resource = [
          "arn:${local.partition}:cloudfront::${local.account_id}:origin-access-control/*",
          "arn:${local.partition}:cloudfront::${local.account_id}:response-headers-policy/*",
        ]
      },
      {
        Sid      = "CreateEdgePolicies"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateOriginAccessControl", "cloudfront:CreateResponseHeadersPolicy"]
        Resource = ["*"]
      },
      {
        # CreateFunction takes no resource ARN and the provider's function takes no tags, so a stack can create a
        # function under any name; the other actions are held to the stack's names.
        Sid      = "CreateCloudFrontFunctions"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateFunction"]
        Resource = ["*"]
      },
      {
        Sid      = "CloudFrontFunctions"
        Effect   = "Allow"
        Action   = ["cloudfront:DeleteFunction", "cloudfront:PublishFunction", "cloudfront:UpdateFunction"]
        Resource = ["arn:${local.partition}:cloudfront::${local.account_id}:function/blockwarden-${env}-*"]
      },
      {
        # the optional custom domain's certificate; RequestCertificate takes no resource ARN and an id is random,
        # so the environment tag ties a certificate to this stack
        Sid       = "RequestCertificates"
        Effect    = "Allow"
        Action    = ["acm:RequestCertificate"]
        Resource  = ["*"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        Sid       = "Certificates"
        Effect    = "Allow"
        Action    = ["acm:DeleteCertificate", "acm:RemoveTagsFromCertificate"]
        Resource  = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        Sid       = "CertificateTags"
        Effect    = "Allow"
        Action    = ["acm:AddTagsToCertificate"]
        Resource  = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env, "aws:RequestTag/environment" = env } }
      },
    ]
  } }

  apply_role_names = { for env in local.environments : env => "blockwarden-${env}-apply" }
}

resource "aws_iam_role" "apply" {
  for_each             = local.environments
  name                 = local.apply_role_names[each.key]
  description          = "terraform apply for the ${each.key} stack, from its GitHub environment only."
  assume_role_policy   = jsonencode(local.trust_policies["${each.key}-apply"])
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "apply_read" {
  for_each   = local.environments
  role       = aws_iam_role.apply[each.key].name
  policy_arn = aws_iam_policy.apply_read[each.key].arn
}

resource "aws_iam_role_policy" "apply" {
  for_each = local.environments
  name     = "apply"
  role     = aws_iam_role.apply[each.key].id
  policy   = jsonencode(local.apply_policies[each.key])
}
