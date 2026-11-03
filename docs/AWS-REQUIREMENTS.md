# What the AWS account owner must provision for the SAFI Office (SOW 016)

Account: 578257747901. Region: ap-south-1 (Mumbai) unless you prefer another; tell us which.
SAFI deploys with `node deploy-office.mjs`. It never creates AWS resources; it only uploads a bundle and runs an install command on an instance you provide. No long-lived access keys are used anywhere.

## 1. Linux instance (the Office)
- One EC2 instance, Amazon Linux 2023 (or Ubuntu 22.04/24.04), t3.small is enough for the demo.
- Root and data volumes: encrypted gp3 EBS (default KMS key is fine). SAFI stores all resumes, profiles and run records on this disk under `/var/lib/safi-office`.
- Node.js 22 LTS (22.9 or newer) or Node 24 LTS, installed system-wide so `/usr/bin/env node` finds it for root and for the `safi` service user (not an nvm-style per-user install). This is the one supported minimum: the production dependencies `canonicalize` and `openai` require Node 22+, and `npm start` uses `--env-file-if-exists`, added in Node 22.9. Node 20 is not supported. The test suite has been run on Node 24 only; 22.9 is the floor declared by the dependencies and the CLI flag. Also needed: `aws` CLI v2, `npm`, `tar`, `curl`, `sha256sum` (all standard on Amazon Linux 2023 except Node: `dnf install nodejs22` or the NodeSource package). The install fails with a clear message if Node is older than 22.9.
- Outbound internet (HTTPS 443) to `api.anthropic.com` (the AI model), npm registry (during install), S3 and SSM endpoints.
- SSM Agent running (preinstalled on Amazon Linux 2023). The instance must show as "Online" in Systems Manager Fleet Manager.
- Confirm `/var/lib/safi-office` is on the encrypted volume (the installer does not check this).

## 2. Instance profile (role attached to the instance)
Attach `AmazonSSMManagedInstanceCore` plus this inline policy (replace the bucket, prefix and parameter names; keep them identical to what you send us in section 7):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadSafiBundle",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::CUSTOMER-SAFI-OFFICE-BUCKET/safi-office/releases/*"
    },
    {
      "Sid": "ReadSafiSecrets",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": [
        "arn:aws:ssm:ap-south-1:578257747901:parameter/safi/office/anthropic-api-key",
        "arn:aws:ssm:ap-south-1:578257747901:parameter/safi/office/candidate-passcode",
        "arn:aws:ssm:ap-south-1:578257747901:parameter/safi/office/trainer-passcode"
      ]
    },
    {
      "Sid": "DecryptSafiSecrets",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:ap-south-1:578257747901:key/KEY-ID-USED-FOR-THE-PARAMETERS",
      "Condition": { "StringEquals": { "kms:ViaService": "ssm.ap-south-1.amazonaws.com" } }
    }
  ]
}
```
If the parameters use the AWS-managed `alias/aws/ssm` key, the `kms:Decrypt` statement may be dropped (that key is usable by anyone with `ssm:GetParameter`); if you use a customer-managed key, keep it and add the instance role to the key policy.

## 3. S3 bucket (bundle drop)
- One private bucket in the same region. Block Public Access: all four settings ON. Default encryption SSE-S3 (or SSE-KMS, then tell us the key id, add `kms:GenerateDataKey` for the deployer, and add `kms:Decrypt` on that key to the instance role, otherwise the instance cannot download the bundle).
- Bucket versioning ON is recommended (keeps every release bundle).
- Bundles go under the prefix `safi-office/releases/<gitsha>-<bundle hash>/` (the prefix is configurable); the bundle hash is part of the key, so a rebuild never overwrites an earlier upload.

## 4. SSM Parameter Store SecureStrings
Create three `SecureString` parameters (Standard tier is fine):

| Parameter name (default) | Value |
|---|---|
| `/safi/office/anthropic-api-key` | the Anthropic API key (`ANTHROPIC_API_KEY`) |
| `/safi/office/candidate-passcode` | passcode the job seeker types to sign in (12+ characters, no quotes or spaces at the ends) |
| `/safi/office/trainer-passcode` | passcode for the SAFI Trainer (different from the candidate one) |

SAFI never reads these values; only the instance does, at every service start, into a root-only tmpfs file (`/run/safi-office/env`).

## 5. How SAFI's deployer identity is granted
Give the SAFI deployer an IAM role (preferred, assumed via IAM Identity Center/SSO or `sts:AssumeRole`) or a user that signs in through SSO. No access keys on the instance, none in config, none in Git. Minimum policy for the deployer (replace names and the instance id):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PutBundle",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::CUSTOMER-SAFI-OFFICE-BUCKET/safi-office/releases/*"
    },
    {
      "Sid": "RunInstallOnTheOffice",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:ap-south-1:578257747901:instance/i-OFFICE-INSTANCE-ID",
        "arn:aws:ssm:ap-south-1::document/AWS-RunShellScript"
      ]
    },
    {
      "Sid": "ReadCommandResults",
      "Effect": "Allow",
      "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"],
      "Resource": "*"
    },
    {
      "Sid": "PingTheOffice",
      "Effect": "Allow",
      "Action": "ssm:DescribeInstanceInformation",
      "Resource": "*"
    }
  ]
}
```
The deployer can run shell commands on that one instance, which is how install, restart and status work. Scope it to this instance only, and remove it when the engagement ends. Add `kms:GenerateDataKey` on the bucket key if SSE-KMS is used.

## 6. Network: how Chrome reaches the Office
The app listens on port 8017 (HTTP). Pick one:
- Recommended: an Application Load Balancer (or CloudFront) with an ACM certificate, HTTPS on 443, forwarding to the instance on 8017; the instance security group allows 8017 only from the load balancer. Then set `bindHost` to `0.0.0.0` (`bindHost` accepts only `127.0.0.1` or `0.0.0.0`), `publicUrl` to the `https://` address (the app then marks its sign-in cookie Secure) and **`trustProxy` to `"1"`** in `config/office.json`. With the load balancer in front, every request reaches the app from the load balancer's address; `trustProxy: "1"` (the installer writes `TRUST_PROXY=1`) makes the app use the real caller address from the load balancer's `X-Forwarded-For`, so a few wrong passcodes from one person cannot lock sign-in for everyone. Leave it `"false"` (the default) for the tunnel and direct options below, and never trust a forwarded header when callers can reach the instance port directly (keep the security group closed to everything but the load balancer).
- Or a Cloudflare/SSM tunnel to `127.0.0.1:8017` (keep `bindHost` `127.0.0.1`).
- Minimum for a demo: security group inbound TCP 8017 from the office/tester IP addresses only (never 0.0.0.0/0), plain HTTP. Sign-in passcodes would travel unencrypted, so use only on a trusted network.
- No inbound SSH is required (everything uses SSM).

## 7. Send back to SAFI
- AWS region and instance id (`i-...`)
- S3 bucket name and prefix (and KMS key id if SSE-KMS)
- The three SSM parameter names
- The URL Chrome should open (and whether it is HTTPS)
- How to sign in as the deployer (SSO start URL and role name, or AWS_PROFILE instructions)
- Confirmation that the instance shows "Online" in Systems Manager and `node -v` is 22.9 or newer

We put these into `config/office.json` (git-ignored), then run `node deploy-office.mjs --dry-run`, `--deploy`, `--status`.
