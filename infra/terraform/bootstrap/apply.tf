# One apply role per stack, each trusted only from its own GitHub environment.
# Writes are scoped to the stack's names where the ARN allows it, otherwise to its environment tag.
# Reads come from the stack's own read policy.
# The list is derived, not proven. Only a real apply can prove an IAM policy complete.
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
        # the table is named exactly blockwarden-<env>, no suffix
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
        # roles can only be created or given an inline policy with this stack's boundary attached
        Sid       = "BoundedRoles"
        Effect    = "Allow"
        Action    = ["iam:CreateRole", "iam:DeleteRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy"]
        Resource  = ["arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-*"]
        Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.boundary[env].arn } }
      },
      {
        # No boundary condition needed: every blockwarden-<env>-* role is made through BoundedRoles,
        # so it already
        # carries the boundary. A role of that name made outside this policy wouldn't be covered.
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
        # Its own name matches the prefix above, so it's shut out of itself, its boundary and its
        # attached managed policies.
        # Nothing here allows a policy write; this keeps that true if a grant is added. No role may
        # lose its boundary.
        Sid    = "NotItself"
        Effect = "Deny"
        Action = ["iam:*"]
        Resource = [
          "arn:${local.partition}:iam::${local.account_id}:role/blockwarden-${env}-apply",
          "arn:${local.partition}:iam::${local.account_id}:policy/blockwarden-${env}-boundary",
          "arn:${local.partition}:iam::${local.account_id}:policy/blockwarden-${env}-apply-edge",
          "arn:${local.partition}:iam::${local.account_id}:policy/blockwarden-${env}-read",
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
        # Lambda picks the mapping id and create takes no resource ARN, so both are held to this
        # stack's functions
        # by the function the mapping names.
        Sid       = "EventSourceMappings"
        Effect    = "Allow"
        Action    = ["lambda:CreateEventSourceMapping", "lambda:DeleteEventSourceMapping", "lambda:UpdateEventSourceMapping"]
        Resource  = ["*"]
        Condition = { ArnLike = { "lambda:FunctionArn" = "arn:${format(local.region_arn, "lambda")}:function:blockwarden-${env}-*" } }
      },
      {
        # Mapping ids are chosen by Lambda and tag actions carry no lambda:FunctionArn key, so they
        # can't be held to
        # the stack's functions. Tagged mappings can be retagged only while they carry this stack's
        # environment tag,
        # untagged ones (a create in progress) only with it in the request. The mapping's own writes
        # are held above.
        Sid       = "EventSourceMappingTags"
        Effect    = "Allow"
        Action    = ["lambda:TagResource"]
        Resource  = ["arn:${format(local.region_arn, "lambda")}:event-source-mapping:*"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env, "aws:ResourceTag/environment" = env } }
      },
      {
        Sid      = "EventSourceMappingCreateTags"
        Effect   = "Allow"
        Action   = ["lambda:TagResource"]
        Resource = ["arn:${format(local.region_arn, "lambda")}:event-source-mapping:*"]
        Condition = {
          StringEquals = { "aws:RequestTag/environment" = env }
          Null         = { "aws:ResourceTag/environment" = "true" }
        }
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
        # CreateKey takes no resource ARN and key ids are random, so a key belongs to the stack by
        # the
        # environment tag from the root's default_tags
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
        # a key can only be tagged with this stack's environment, so one stack can't hand its key to
        # the other
        Sid       = "KeyTags"
        Effect    = "Allow"
        Action    = ["kms:TagResource"]
        Resource  = ["arn:${format(local.region_arn, "kms")}:key/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env, "aws:RequestTag/environment" = env } }
      },
      {
        # CreateKey with tags is also authorised as kms:TagResource on a key with no tag yet.
        # Allowed only while the key
        # has no environment tag and the request sets this stack's, so a key tagged for the other
        # stack stays out of reach.
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
        # Only what Terraform writes: the session secret and module-made API keys. The RPC URLs and
        # webhook secret
        # under the same path are the owner's; this role can't read or overwrite them.
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
        # API Gateway sets up an HTTP API stage's access log via CloudWatch Logs' delivery API with
        # the caller's
        # credentials, and none of these actions takes a resource ARN
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
        # Bucket names come from bucket_prefix so they carry the stack's name.
        # GetBucketAcl/PutBucketAcl on the log
        # bucket is how CloudFront standard logging grants itself write access. The object actions
        # are the deploy's
        # sync of the dashboard export.
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
    ]
  } }

  # Grants for services where AWS picks the resource ids (API Gateway, CloudFront, ACM), held to the
  # stack by its
  # environment tag. Separate managed policy because a role's inline policies share one 10,240
  # character limit.
  apply_edge_policies = { for env in local.environments : env => {
    Version = "2012-10-17"
    Statement = [
      {
        # AWS picks an HTTP API's id, so a stack's APIs are told apart by the environment tag from
        # the root's
        # default_tags: created only with it, changed or deleted only while they carry it.
        Sid       = "CreateApis"
        Effect    = "Allow"
        Action    = ["apigateway:POST"]
        Resource  = ["arn:${local.partition}:apigateway:${var.region}::/apis"]
        Condition = { StringEquals = { "aws:RequestTag/environment" = env } }
      },
      {
        # Routes, integrations, authorizers and stages are authorised by the tags of their API.
        # Nothing here writes
        # /tags/*: that path has no resource-tag condition key, so a role that could would retag the
        # other stack's API.
        # Tags are set at create time; changing them is the owner's job.
        Sid       = "Apis"
        Effect    = "Allow"
        Action    = ["apigateway:DELETE", "apigateway:PATCH", "apigateway:POST", "apigateway:PUT"]
        Resource  = ["arn:${local.partition}:apigateway:${var.region}::/apis/*"]
        Condition = { StringEquals = { "aws:ResourceTag/environment" = env } }
      },
      {
        # CloudFront picks a distribution's id, so they're told apart by the environment tag:
        # created only with it,
        # changed, tagged or deleted only while they carry it. The provider creates one via
        # CreateDistributionWithTags,
        # which isn't an IAM action: the API needs cloudfront:CreateDistribution (no resource ARN)
        # and
        # cloudfront:TagResource, below.
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
        # the TagResource half of a tagged create, on a distribution with no tag yet; see
        # KeyCreateTags
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
        # An origin access control takes no tags and CloudFront picks its id, so neither a name nor
        # a tag can hold it to
        # the stack, and one stack can change or delete the other's. That only affects availability:
        # it signs CloudFront's
        # requests to the bucket and holds no content. The security headers are a named function
        # instead of a
        # response headers policy for the same reason.
        Sid      = "EdgePolicies"
        Effect   = "Allow"
        Action   = ["cloudfront:DeleteOriginAccessControl", "cloudfront:UpdateOriginAccessControl"]
        Resource = ["arn:${local.partition}:cloudfront::${local.account_id}:origin-access-control/*"]
      },
      {
        Sid      = "CreateEdgePolicies"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateOriginAccessControl"]
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
        # the optional custom domain's certificate. RequestCertificate takes no resource ARN and ids
        # are random, so the
        # environment tag ties a certificate to this stack
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
      {
        # RequestCertificate with tags may also be authorised as acm:AddTagsToCertificate on a
        # certificate with no tag
        # yet; see KeyCreateTags
        Sid      = "CertificateCreateTags"
        Effect   = "Allow"
        Action   = ["acm:AddTagsToCertificate"]
        Resource = ["arn:${local.partition}:acm:us-east-1:${local.account_id}:certificate/*"]
        Condition = {
          StringEquals = { "aws:RequestTag/environment" = env }
          Null         = { "aws:ResourceTag/environment" = "true" }
        }
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

resource "aws_iam_policy" "apply_edge" {
  for_each    = local.environments
  name        = "blockwarden-${each.key}-apply-edge"
  description = "What the ${each.key} apply role may do to API Gateway, CloudFront and ACM, held to its environment tag."
  policy      = jsonencode(local.apply_edge_policies[each.key])
}

resource "aws_iam_role_policy_attachment" "apply_edge" {
  for_each   = local.environments
  role       = aws_iam_role.apply[each.key].name
  policy_arn = aws_iam_policy.apply_edge[each.key].arn
}
