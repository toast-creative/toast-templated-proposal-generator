#!/usr/bin/env bash
#
# One-time bootstrap: let GitHub Actions deploy to the Toast AWS account via OIDC.
#
# Run this ONCE, by someone with IAM admin on account 169055532179. It creates:
#   1. A GitHub OIDC identity provider (if one doesn't already exist).
#   2. An IAM role that only THIS repo's `main` branch can assume.
#   3. A scoped policy on that role: push to ECR, roll the ECS service, invalidate CloudFront.
#
# It is idempotent — re-running updates the policies in place. At the end it prints the
# role ARN; paste that into the GitHub repo variable AWS_DEPLOY_ROLE_ARN
# (Settings → Secrets and variables → Actions → Variables).
#
# Usage:
#   AWS_PROFILE=toast ./deploy/bootstrap-oidc.sh
#
set -euo pipefail

# --- Constants (match the existing deployed infrastructure) -------------------
ACCOUNT_ID="169055532179"
REGION="ap-southeast-2"
GH_REPO="toast-creative/toast-templated-proposal-generator"
GH_BRANCH="main"

# GitHub OIDC subject claim. This org has GitHub's *immutable subject claim*
# enabled, so the `sub` embeds numeric owner/repo IDs:
#   repo:<owner>@<owner_id>/<repo>@<repo_id>:<ref...>
# We trust BOTH that form and the classic `repo:<owner>/<repo>:...` form so the
# role keeps working whether or not immutable subjects are on. Re-derive the
# immutable prefix with:
#   gh api /repos/${GH_REPO}/actions/oidc/customization/sub  ->  .sub_claim_prefix
GH_SUB_IMMUTABLE="repo:toast-creative@292269961/toast-templated-proposal-generator@1332703028"

ROLE_NAME="toast-proposal-demo-gha-deploy"
POLICY_NAME="toast-proposal-demo-gha-deploy-policy"
ECR_REPO="toast-proposal-demo"
ECS_CLUSTER="toast-proposal-demo"
ECS_SERVICE="toast-proposal-demo"
EXEC_ROLE_NAME="toast-proposal-demo-ecs-exec"
CLOUDFRONT_DIST_ID="E2L98N6EXLVO2K"

OIDC_HOST="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

echo "==> Verifying credentials point at account ${ACCOUNT_ID}..."
CURRENT_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
if [[ "${CURRENT_ACCOUNT}" != "${ACCOUNT_ID}" ]]; then
  echo "ERROR: current credentials are for account ${CURRENT_ACCOUNT}, expected ${ACCOUNT_ID}." >&2
  echo "       Set AWS_PROFILE (e.g. AWS_PROFILE=toast) and retry." >&2
  exit 1
fi

# --- 1. OIDC provider ---------------------------------------------------------
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${OIDC_ARN}" >/dev/null 2>&1; then
  echo "==> OIDC provider already exists: ${OIDC_ARN}"
else
  echo "==> Creating GitHub OIDC provider..."
  # IAM now validates the provider's TLS chain itself, but a thumbprint is still
  # required by the API. This is GitHub's well-known intermediate thumbprint.
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_HOST}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" >/dev/null
  echo "    created ${OIDC_ARN}"
fi

# --- 2. IAM role with a repo-scoped trust policy ------------------------------
TRUST_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_HOST}:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "${OIDC_HOST}:sub": [
            "${GH_SUB_IMMUTABLE}:*",
            "repo:${GH_REPO}:*"
          ]
        }
      }
    }
  ]
}
JSON
)"

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "==> Role ${ROLE_NAME} exists — updating trust policy..."
  aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "${TRUST_POLICY}" >/dev/null
else
  echo "==> Creating role ${ROLE_NAME}..."
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --description "GitHub Actions deploy role for ${GH_REPO} (${GH_BRANCH})" \
    --assume-role-policy-document "${TRUST_POLICY}" >/dev/null
fi

# --- 3. Scoped permissions policy ---------------------------------------------
PERMS_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuth",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "EcrPushPull",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
      ],
      "Resource": "arn:aws:ecr:${REGION}:${ACCOUNT_ID}:repository/${ECR_REPO}"
    },
    {
      "Sid": "EcsRegisterTaskDef",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeTaskDefinition",
        "ecs:RegisterTaskDefinition"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcsDeploy",
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeServices",
        "ecs:UpdateService"
      ],
      "Resource": "arn:aws:ecs:${REGION}:${ACCOUNT_ID}:service/${ECS_CLUSTER}/${ECS_SERVICE}"
    },
    {
      "Sid": "PassExecRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${EXEC_ROLE_NAME}",
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    },
    {
      "Sid": "CloudFrontInvalidate",
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::${ACCOUNT_ID}:distribution/${CLOUDFRONT_DIST_ID}"
    }
  ]
}
JSON
)"

echo "==> Attaching scoped inline policy ${POLICY_NAME}..."
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "${PERMS_POLICY}" >/dev/null

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text)"

cat <<DONE

==> Done.

    Role ARN:  ${ROLE_ARN}

    Next step: set this as a GitHub Actions *variable* (not a secret) named
    AWS_DEPLOY_ROLE_ARN on the repo:

      gh variable set AWS_DEPLOY_ROLE_ARN \\
        --repo ${GH_REPO} \\
        --body "${ROLE_ARN}"

    Then push to '${GH_BRANCH}' and watch .github/workflows/deploy.yml run.
DONE
