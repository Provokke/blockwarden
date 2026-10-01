output "state_bucket" {
  description = "The bucket each stack's backend names with -backend-config=bucket=..."
  value       = aws_s3_bucket.state.bucket
}

output "region" {
  description = "The state bucket's region, which is also where the stacks deploy."
  value       = var.region
}

output "plan_role_arn" {
  description = "Role the plan workflow assumes."
  value       = aws_iam_role.plan.arn
}

output "github_variables" {
  description = "Commands that set the repository variables the workflows read. Print with terraform output -raw github_variables."
  value = join("\n", [
    "gh variable set BLOCKWARDEN_AWS_REGION --repo ${var.github_repository} --body ${var.region}",
    "gh variable set BLOCKWARDEN_STATE_BUCKET --repo ${var.github_repository} --body ${aws_s3_bucket.state.bucket}",
    "gh variable set BLOCKWARDEN_PLAN_ROLE_ARN --repo ${var.github_repository} --body ${aws_iam_role.plan.arn}",
  ])
}
