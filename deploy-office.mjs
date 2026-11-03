// Customer-Office deployment (SOW 017 deploy-office.mjs). Builds the runtime bundle, uploads it to the
// customer-owned S3 bucket and installs it on the SOW 016 Office instance through SSM Run Command.
//
//   node deploy-office.mjs --dry-run | --deploy | --status | --restart [--config config/office.json] [--json]
//
// Library use (the Express server): `await deploy({ mode }, { root, dataDir, clients? })` returns a JSON report
// and throws FactoryError (plain English message) on any failure. Credentials come only from the default AWS
// provider chain (AWS_PROFILE / SSO / instance role). Nothing secret is ever read from or written to config.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand, DescribeInstanceInformationCommand } from '@aws-sdk/client-ssm';
import { FactoryError } from './lib/canonical.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODES = ['dry-run', 'deploy', 'status', 'restart'];
export const SSM_DOCUMENT = 'AWS-RunShellScript';
export const SERVICE = 'safi-jobcoach';

// ---------------------------------------------------------------- config ----
const REQUIRED = {
  region: { re: /^[a-z]{2}(-[a-z]+)+-\d$/, help: 'AWS region of the customer Office, for example "ap-south-1".' },
  instanceId: { re: /^i-[0-9a-f]{8,17}$/, help: 'EC2 instance id of the SOW 016 Office, like "i-0123456789abcdef0".' },
  bucket: { re: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, help: 'Customer S3 bucket (encrypted, private) that receives the bundle.' },
  secretParameterName: { re: /^[A-Za-z0-9_.\-/]+$/, help: 'SSM Parameter Store SecureString name that holds ANTHROPIC_API_KEY.' },
  candidatePasscodeParameterName: { re: /^[A-Za-z0-9_.\-/]+$/, help: 'SSM SecureString name holding the Candidate passcode.' },
  trainerPasscodeParameterName: { re: /^[A-Za-z0-9_.\-/]+$/, help: 'SSM SecureString name holding the Trainer passcode.' }
};
const OPTIONAL = {
  prefix: { re: /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, def: 'safi-office/releases', help: 'S3 key prefix for bundles.' },
  port: { def: 8017, help: 'TCP port of the Office web server.' },
  bindHost: { re: /^(127\.0\.0\.1|0\.0\.0\.0)$/, def: '127.0.0.1', help: 'Address the server binds on the instance: 127.0.0.1 or 0.0.0.0 only (use 0.0.0.0 only behind a restricted security group).' },
  trustProxy: { re: /^(false|[0-9]{1,2}|loopback)$/, def: 'false', help: 'How many reverse proxies (for example one Application Load Balancer) sit in front of the Office: "false" (none, the default), a number such as "1", or "loopback". Set "1" behind an ALB so the passcode throttle sees each caller, not the load balancer.' },
  publicUrl: { re: /^https?:\/\/[^\s'"`$\\]+$/, def: null, help: 'URL Chrome uses to reach the Office (shown in reports).' },
  kmsKeyId: { re: /^[A-Za-z0-9:/_-]+$/, def: null, help: 'Optional KMS key id/ARN for S3 SSE (default: S3-managed AES256).' }
};
const FORBIDDEN_KEYS = /(access.?key|secret.?access|session.?token|password|api.?key)$/i;

export function configPath(root, explicit) {
  return path.resolve(root, explicit ?? path.join('config', 'office.json'));
}

/** Read and validate the config. Returns { ok, config, missing[], invalid[], path, exists }. Never throws on content. */
export function loadOfficeConfig(root, explicit) {
  const file = configPath(root, explicit);
  const out = { path: file, exists: existsSync(file), ok: false, config: null, missing: [], invalid: [] };
  let raw = {};
  if (out.exists) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      out.invalid.push({ field: '(file)', problem: `${file} is not valid JSON: ${e.message}` });
      raw = {};
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      out.invalid.push({ field: '(file)', problem: 'The config must be a JSON object.' });
      raw = {};
    }
  }
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.test(key)) {
      out.invalid.push({ field: key, problem: 'Credentials must never be stored in this file. Use AWS_PROFILE / SSO / an instance role instead.' });
    }
  }
  const cfg = {};
  for (const [name, spec] of Object.entries(REQUIRED)) {
    const v = raw[name];
    if (v === undefined || v === null || v === '') out.missing.push({ field: name, help: spec.help });
    else if (typeof v !== 'string' || !spec.re.test(v) || v.includes('..')) out.invalid.push({ field: name, problem: `"${String(v)}" does not look right. ${spec.help}` });
    else cfg[name] = v;
  }
  for (const [name, spec] of Object.entries(OPTIONAL)) {
    let v = raw[name];
    if (v === undefined || v === null || v === '') v = spec.def;
    if (name === 'port') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) { out.invalid.push({ field: name, problem: `"${v}" is not a valid port (1 to 65535).` }); continue; }
      cfg.port = n;
    } else if (v !== null) {
      if (typeof v !== 'string' || !spec.re.test(v) || v.includes('..')) { out.invalid.push({ field: name, problem: `"${String(v)}" does not look right. ${spec.help}` }); continue; }
      cfg[name] = name === 'prefix' ? v.replace(/^\/+|\/+$/g, '') : v;
    } else cfg[name] = null;
  }
  out.config = cfg;
  out.ok = out.missing.length === 0 && out.invalid.length === 0;
  return out;
}

function requireConfig(loaded, action) {
  if (loaded.ok) return loaded.config;
  const lines = [
    ...loaded.missing.map((m) => `  - ${m.field}: ${m.help}`),
    ...loaded.invalid.map((m) => `  - ${m.field}: ${m.problem}`)
  ];
  const where = loaded.exists ? `Fix ${loaded.path}` : `Create ${loaded.path} (copy config/office.example.json)`;
  throw new FactoryError(
    `Cannot ${action}: the Office settings are not complete.\n${lines.join('\n')}\n${where}. The AWS account owner supplies these values (see docs/AWS-REQUIREMENTS.md).`,
    'OFFICE_NOT_CONFIGURED', { missing: loaded.missing, invalid: loaded.invalid }
  );
}

// ---------------------------------------------------------------- bundle ----
const BUNDLE_DIRS = ['lib', 'server', 'schemas', 'skills', 'knowledge', 'registry', 'office', path.posix.join('client', 'dist')];
const BUNDLE_FILES = ['factory.mjs', 'package.json', 'package-lock.json', path.posix.join('config', 'office-grants.json')];
const SKIP_NAMES = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const SECRET_NAME = (n) => /^\.env/i.test(n) || /\.(pem|key|p12|pfx|crt)$/i.test(n) || /^id_(rsa|ed25519|ecdsa)/.test(n) || /^passcodes/i.test(n) || /^\.session/i.test(n) || /^\.secret/i.test(n);
const SECRET_CONTENT = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\bsk-[A-Za-z0-9]{32,}/, 'an API key'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/aws_secret_access_key\s*[=:]/i, 'an AWS secret access key']
];
const DEMO_FIXTURE = /^(alex-example\.[A-Za-z0-9.-]+|job-[a-z0-9-]+\.(txt|meta\.json))$/;
const DEMO_FIXTURE_REQUIRED = ['alex-example.profile.json', 'alex-example.resume.txt', 'job-swe-entry.txt', 'job-swe-entry.meta.json'];
const toPosix = (p) => p.split(path.sep).join('/');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  for (const name of readdirSync(abs).sort()) {
    if (SKIP_NAMES.has(name) || SECRET_NAME(name)) continue;
    const r = path.join(rel, name);
    const st = statSync(path.join(root, r));
    if (st.isDirectory()) walk(root, r, out);
    else if (st.isFile()) out.push(toPosix(r));
  }
}

/** The exact list of runtime files that would be bundled, plus anything that blocks building. */
export function collectBundleFiles(root) {
  const files = [];
  const problems = [];
  for (const f of BUNDLE_FILES) {
    if (existsSync(path.join(root, f))) files.push(f);
    else problems.push(`Required file ${f} is missing.`);
  }
  for (const d of BUNDLE_DIRS) {
    if (!existsSync(path.join(root, d)) || !statSync(path.join(root, d)).isDirectory()) {
      problems.push(d === 'client/dist' ? 'client/dist is missing: run npm run build first.' : `Required folder ${d}/ is missing.`);
      continue;
    }
    walk(root, d, files);
  }
  // Released templates only: exactly the templates the registry lists (drafts/ is never bundled).
  const regFile = path.join(root, 'registry', 'index.json');
  if (existsSync(regFile)) {
    for (const e of JSON.parse(readFileSync(regFile, 'utf8'))) {
      if (e.kind !== 'template') continue;
      if (existsSync(path.join(root, e.path))) files.push(toPosix(e.path));
      else problems.push(`Registry lists ${e.path} but the file is missing.`);
    }
  }
  // Synthetic demo fixtures only (GET /fixtures/demo, "Fill with Alex Example", sample job postings).
  // fixtures/negative/ and adversarial-job.* are test-only and stay out.
  const fixDir = path.join(root, 'fixtures');
  if (existsSync(fixDir)) {
    for (const name of readdirSync(fixDir).sort()) {
      if (DEMO_FIXTURE.test(name) && statSync(path.join(fixDir, name)).isFile()) files.push(`fixtures/${name}`);
    }
  }
  for (const need of DEMO_FIXTURE_REQUIRED) {
    if (!files.includes(`fixtures/${need}`)) problems.push(`Demo fixture fixtures/${need} is missing (the Office needs it for "Fill with Alex Example").`);
  }
  if (existsSync(path.join(root, 'client', 'dist')) && !existsSync(path.join(root, 'client', 'dist', 'index.html'))) {
    problems.push('client/dist has no index.html: run npm run build first.');
  }
  return { files: [...new Set(files)].sort(), problems };
}

export function gitShaOf(root, override) {
  if (override) return override;
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return process.env.GIT_SHA ?? 'nogit';
  }
}

function gitDirty(root) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--', ...BUNDLE_FILES, ...BUNDLE_DIRS.filter((d) => d !== 'client/dist'), 'templates'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Build the bundle. Writes release/office-bundle/<gitsha>/{safi-office-<gitsha>.tgz, manifest.json} under `root`
 * (or `outDir`). Throws FactoryError if anything required is missing or secret-looking content is found.
 */
export function buildBundle({ root, outDir, gitSha } = {}) {
  root = path.resolve(root ?? HERE);
  const { files, problems } = collectBundleFiles(root);
  if (problems.length) {
    throw new FactoryError(`Cannot build the Office bundle:\n${problems.map((p) => `  - ${p}`).join('\n')}`, 'OFFICE_BUNDLE_INCOMPLETE', { problems });
  }
  const entries = [];
  for (const f of files) {
    const buf = readFileSync(path.join(root, f));
    const text = buf.length < 4_000_000 ? buf.toString('latin1') : '';
    for (const [re, what] of SECRET_CONTENT) {
      if (re.test(text)) {
        throw new FactoryError(`Refusing to bundle ${f}: it looks like it contains ${what}. Remove it and build again.`, 'OFFICE_BUNDLE_SECRET', { file: f });
      }
    }
    entries.push({ path: f, bytes: buf.length, sha256: sha256(buf) });
  }
  const sha = gitShaOf(root, gitSha);
  const dir = path.resolve(outDir ?? path.join(root, 'release', 'office-bundle', sha));
  mkdirSync(dir, { recursive: true });
  const bundleName = `safi-office-${sha}.tgz`;
  const bundlePath = path.join(dir, bundleName);
  tar.c({ file: bundlePath, cwd: root, gzip: true, portable: true, noPax: true, mtime: new Date(0), sync: true }, files);
  const bundleBuf = readFileSync(bundlePath);
  const manifest = {
    schema: 'safi-office-bundle/1',
    gitSha: sha,
    dirty: gitDirty(root),
    fileCount: entries.length,
    files: entries,
    bundle: { name: bundleName, bytes: bundleBuf.length, sha256: sha256(bundleBuf) }
  };
  const manifestPath = path.join(dir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { dir, bundlePath, manifestPath, manifest, gitSha: sha, bundleSha256: manifest.bundle.sha256, files };
}

/** Re-hash an extracted/installed tree against a manifest. Returns list of mismatches (empty = verified). */
export function verifyManifest(manifest, dir) {
  const bad = [];
  for (const e of manifest.files) {
    const p = path.join(dir, e.path);
    if (!existsSync(p)) bad.push({ path: e.path, problem: 'missing' });
    else if (sha256(readFileSync(p)) !== e.sha256) bad.push({ path: e.path, problem: 'hash mismatch' });
  }
  return bad;
}

// ---------------------------------------------------------------- plan -------
export function plan(cfg, built) {
  const sha = built?.gitSha ?? '<gitsha>';
  const bundleName = built?.manifest?.bundle?.name ?? `safi-office-${sha}.tgz`;
  const bundleSha = built?.bundleSha256 ?? '<bundle-sha256>';
  const releaseId = built ? `${sha}-${bundleSha.slice(0, 8)}` : '<gitsha>-<first 8 of bundle sha256>';
  // The release id includes the bundle hash, so rebuilding a dirty tree for the same git sha never overwrites an earlier upload.
  const keyDir = `${cfg.prefix}/${releaseId}`;
  const s3Key = `${keyDir}/${bundleName}`;
  const manifestKey = `${keyDir}/manifest.json`;
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const installCommands = [
    'set -eu',
    'STAGE=$(mktemp -d)',
    `trap 'rm -rf "$STAGE"' EXIT`,
    `aws s3 cp ${q(`s3://${cfg.bucket}/${s3Key}`)} "$STAGE/bundle.tgz" --region ${q(cfg.region)} --only-show-errors`,
    `echo "${bundleSha}  $STAGE/bundle.tgz" | sha256sum -c -`,
    'tar -xzf "$STAGE/bundle.tgz" -C "$STAGE" office',
    [
      'bash "$STAGE/office/install.sh"', '--bundle-file "$STAGE/bundle.tgz"',
      `--sha ${q(bundleSha)}`, `--release ${q(releaseId)}`, `--region ${q(cfg.region)}`, `--port ${cfg.port}`, `--host ${q(cfg.bindHost)}`,
      `--secure-cookie ${cfg.publicUrl?.startsWith('https://') ? 1 : 0}`, `--trust-proxy ${q(cfg.trustProxy ?? 'false')}`,
      `--secret-param ${q(cfg.secretParameterName)}`, `--candidate-param ${q(cfg.candidatePasscodeParameterName)}`, `--trainer-param ${q(cfg.trainerPasscodeParameterName)}`
    ].join(' ')
  ];
  const health = `http://127.0.0.1:${cfg.port}/api/v1/health`;
  const restartCommands = [
    'set -eu',
    `systemctl restart ${SERVICE}`,
    'H=$(mktemp)',
    `trap 'rm -f "$H"' EXIT`,
    'ok=0',
    'for i in $(seq 1 30); do',
    `  if curl -fsS --max-time 5 ${health} >"$H" 2>/dev/null; then ok=1; break; fi`,
    '  sleep 2',
    'done',
    `if [ "$ok" != 1 ]; then echo "The Office did not become healthy after restart." >&2; journalctl -u ${SERVICE} -n 20 --no-pager >&2 || true; exit 1; fi`,
    'echo "health=$(cat "$H")"'
  ];
  const statusCommands = [
    `echo "service=$(systemctl is-active ${SERVICE} || true)"`,
    'echo "release=$(readlink /opt/safi-office/current || echo none)"',
    `if h=$(curl -fsS --max-time 5 ${health} 2>/dev/null); then echo "health=$h"; else echo "health=UNREACHABLE"; fi`
  ];
  return { releaseId, s3Key, manifestKey, bundleName, bundleSha, installCommands, restartCommands, statusCommands, healthUrl: health };
}

// ---------------------------------------------------------------- AWS --------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AWS_HINT = 'Check your AWS sign-in (for example run "aws sso login" or set AWS_PROFILE) and that the deployer role allows this action.';

function awsFail(step, e) {
  const msg = e?.name === 'CredentialsProviderError' || /credential/i.test(e?.message ?? '')
    ? 'No AWS credentials were found. Sign in with the AWS CLI (aws sso login) or set AWS_PROFILE, then try again.'
    : `${e?.name ?? 'Error'}: ${e?.message ?? e}`;
  return new FactoryError(`Could not ${step}. ${msg}\n${AWS_HINT}`, 'OFFICE_AWS_ERROR');
}

async function call(client, step, command) {
  try {
    return await client.send(command);
  } catch (e) {
    throw awsFail(step, e);
  }
}

function makeClients(cfg, injected) {
  return { s3: injected?.s3 ?? new S3Client({ region: cfg.region }), ssm: injected?.ssm ?? new SSMClient({ region: cfg.region }) };
}

const DONE_FAIL = new Set(['Failed', 'TimedOut', 'Cancelled', 'Cancelling', 'DeliveryTimedOut', 'ExecutionTimedOut', 'Undeliverable', 'Terminated', 'AccessDenied', 'NoInstancesInTag', 'LimitExceeded']);

/** Run shell commands on the instance via SSM and wait for the result. Throws OFFICE_COMMAND_FAILED on any non-Success. */
async function runOnInstance(ssm, cfg, label, commands, { pollMs, timeoutMs, executionTimeout = 1200 }) {
  const sent = await call(ssm, `start "${label}" on the Office (SSM SendCommand)`, new SendCommandCommand({
    InstanceIds: [cfg.instanceId],
    DocumentName: SSM_DOCUMENT,
    Comment: `SAFI Office: ${label}`.slice(0, 100),
    TimeoutSeconds: 60,
    Parameters: { commands, executionTimeout: [String(executionTimeout)] }
  }));
  const commandId = sent?.Command?.CommandId;
  if (!commandId) throw new FactoryError(`The Office did not accept the "${label}" command (no command id came back from SSM).`, 'OFFICE_COMMAND_FAILED');
  const t0 = Date.now();
  let missing = 0;
  for (;;) {
    let inv;
    try {
      inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: cfg.instanceId }));
    } catch (e) {
      if (e?.name === 'InvocationDoesNotExist' && missing++ < 10) { await sleep(pollMs); continue; }
      throw awsFail(`read the result of "${label}" (SSM GetCommandInvocation)`, e);
    }
    const status = inv.Status;
    if (status === 'Success') {
      return { commandId, status, stdout: inv.StandardOutputContent ?? '', stderr: inv.StandardErrorContent ?? '' };
    }
    if (DONE_FAIL.has(status)) {
      const tail = (s) => (s ?? '').trim().split('\n').slice(-12).join('\n');
      throw new FactoryError(
        `"${label}" on the Office did not succeed (SSM status: ${status}).${inv.StandardErrorContent ? `\nThe Office said:\n${tail(inv.StandardErrorContent)}` : ''}${inv.StandardOutputContent ? `\nOutput:\n${tail(inv.StandardOutputContent)}` : ''}\nNo release was marked as live. Fix the problem above and run it again.`,
        'OFFICE_COMMAND_FAILED', { commandId, status }
      );
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new FactoryError(`"${label}" on the Office is still ${status} after ${Math.round(timeoutMs / 1000)} seconds. SSM command id ${commandId}; check it in the AWS console (Systems Manager, Run Command).`, 'OFFICE_COMMAND_TIMEOUT', { commandId });
    }
    await sleep(pollMs);
  }
}

const parseKv = (text) => Object.fromEntries(text.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));

// ---------------------------------------------------------------- modes ------
function dryRun(root, loaded) {
  const steps = [];
  const add = (title, detail, extra = {}) => steps.push({ n: steps.length + 1, title, detail, awsCall: false, ...extra });
  let built = null;
  let bundleInfo;
  const { files, problems } = collectBundleFiles(root);
  if (problems.length) {
    bundleInfo = { ok: false, problems };
  } else {
    try {
      built = buildBundle({ root });
      bundleInfo = { ok: true, fileCount: built.files.length, bundleSha256: built.bundleSha256, bundlePath: built.bundlePath, manifestPath: built.manifestPath };
    } catch (e) {
      bundleInfo = { ok: false, problems: [e.message] };
    }
  }
  add('Check Office settings', loaded.ok ? `Using ${loaded.path}.` : `Settings are incomplete in ${loaded.path}${loaded.exists ? '' : ' (file not found; copy config/office.example.json)'}.`);
  add('Build the runtime bundle', bundleInfo.ok
    ? `${bundleInfo.fileCount} runtime files, sha256 ${bundleInfo.bundleSha256}. Written to ${path.relative(root, built.dir)}/. Drafts, data, .env files, tests and negative/adversarial fixtures are never included.`
    : `Cannot build yet:\n${bundleInfo.problems.map((p) => `    - ${p}`).join('\n')}`);
  void files;
  if (loaded.ok) {
    const p = plan(loaded.config, built);
    add('Upload to the customer S3 bucket', `PutObject s3://${loaded.config.bucket}/${p.s3Key} and s3://${loaded.config.bucket}/${p.manifestKey} with server-side encryption (${loaded.config.kmsKeyId ? 'aws:kms' : 'AES256'}).`, { awsCall: true });
    add(`Install on instance ${loaded.config.instanceId}`, `SSM SendCommand, document ${SSM_DOCUMENT}, runs office/install.sh:\n${p.installCommands.map((c) => `      ${c}`).join('\n')}`, { awsCall: true });
    add('Wait for the install to finish', 'Poll SSM GetCommandInvocation every few seconds until Success or a failure status; a failure is reported with the Office\'s own error text.', { awsCall: true });
    add('Health check', `The install script checks ${p.healthUrl} on the instance and rolls back to the previous release if it is not healthy.${loaded.config.publicUrl ? ` Chrome URL: ${loaded.config.publicUrl}` : ''}`);
    return { mode: 'dry-run', ok: true, configured: true, awsCalls: 0, bundle: bundleInfo, plan: { s3Bucket: loaded.config.bucket, s3Key: p.s3Key, manifestKey: p.manifestKey, ssmDocument: SSM_DOCUMENT, instanceId: loaded.config.instanceId, releaseId: p.releaseId, commands: p.installCommands, restartCommands: p.restartCommands, statusCommands: p.statusCommands }, steps };
  }
  const detailLines = [...loaded.missing.map((m) => `${m.field}: ${m.help}`), ...loaded.invalid.map((m) => `${m.field}: ${m.problem}`)];
  add('Upload to the customer S3 bucket', 'PutObject of the bundle and manifest into the customer bucket (needs bucket, prefix, region).', { awsCall: true });
  add('Install on the Office instance', `SSM SendCommand (${SSM_DOCUMENT}) runs office/install.sh on the instance (needs instanceId, region and the three SSM parameter names).`, { awsCall: true });
  add('Wait and health check', 'Poll SSM until the install finishes, then check the Office health URL.', { awsCall: true });
  return {
    mode: 'dry-run', ok: true, configured: false, awsCalls: 0, bundle: bundleInfo,
    missing: loaded.missing, invalid: loaded.invalid,
    message: `Nothing was deployed and no AWS call was made. These settings are missing or wrong in ${loaded.path}:\n  - ${detailLines.join('\n  - ')}\nThe AWS account owner provides them (docs/AWS-REQUIREMENTS.md).`,
    steps
  };
}

async function doDeploy(root, loaded, opts) {
  const cfg = requireConfig(loaded, 'deploy');
  const built = buildBundle({ root });
  const p = plan(cfg, built);
  const clients = makeClients(cfg, opts.clients);
  const enc = cfg.kmsKeyId ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: cfg.kmsKeyId } : { ServerSideEncryption: 'AES256' };
  const steps = [{ step: 'build', ok: true, files: built.files.length, bundleSha256: built.bundleSha256 }];
  await call(clients.s3, `upload the bundle to s3://${cfg.bucket}/${p.s3Key}`, new PutObjectCommand({
    Bucket: cfg.bucket, Key: p.s3Key, Body: readFileSync(built.bundlePath), ContentType: 'application/gzip', ...enc,
    Metadata: { 'safi-bundle-sha256': built.bundleSha256 }
  }));
  await call(clients.s3, `upload the manifest to s3://${cfg.bucket}/${p.manifestKey}`, new PutObjectCommand({
    Bucket: cfg.bucket, Key: p.manifestKey, Body: readFileSync(built.manifestPath), ContentType: 'application/json', ...enc
  }));
  steps.push({ step: 'upload', ok: true, bucket: cfg.bucket, key: p.s3Key, manifestKey: p.manifestKey });
  const res = await runOnInstance(clients.ssm, cfg, 'install release', p.installCommands, opts.timing);
  steps.push({ step: 'install', ok: true, commandId: res.commandId, status: res.status });
  return {
    mode: 'deploy', ok: true, release: p.releaseId, gitSha: built.gitSha, bundleSha256: built.bundleSha256,
    s3: { bucket: cfg.bucket, key: p.s3Key, manifestKey: p.manifestKey }, ssm: { instanceId: cfg.instanceId, document: SSM_DOCUMENT, commandId: res.commandId, status: res.status },
    publicUrl: cfg.publicUrl, output: res.stdout.trim().split('\n').slice(-20).join('\n'), steps,
    warnings: built.manifest.dirty ? ['The working tree has uncommitted changes in bundled files, so this release is not exactly the committed code. Commit before the real hand-over.'] : []
  };
}

async function doRestart(loaded, opts) {
  const cfg = requireConfig(loaded, 'restart the Office');
  const clients = makeClients(cfg, opts.clients);
  const p = plan(cfg, null);
  const res = await runOnInstance(clients.ssm, cfg, 'restart service', p.restartCommands, { ...opts.timing, executionTimeout: 300 });
  const kv = parseKv(res.stdout);
  return { mode: 'restart', ok: true, ssm: { instanceId: cfg.instanceId, document: SSM_DOCUMENT, commandId: res.commandId, status: res.status }, health: kv.health ?? null, publicUrl: cfg.publicUrl, output: res.stdout.trim() };
}

async function doStatus(loaded, opts) {
  if (!loaded.ok) {
    return {
      mode: 'status', ok: false, state: 'NOT_CONFIGURED', missing: loaded.missing, invalid: loaded.invalid,
      message: `The Office is not configured yet, so there is nothing to check. Missing or wrong settings in ${loaded.path}: ${[...loaded.missing.map((m) => m.field), ...loaded.invalid.map((m) => m.field)].join(', ')}.`
    };
  }
  const cfg = loaded.config;
  const clients = makeClients(cfg, opts.clients);
  const info = await call(clients.ssm, 'check the Office instance in SSM (DescribeInstanceInformation)', new DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [cfg.instanceId] }] }));
  const inst = info?.InstanceInformationList?.[0];
  if (!inst) {
    return { mode: 'status', ok: false, state: 'NOT_REGISTERED', instanceId: cfg.instanceId, message: `Instance ${cfg.instanceId} is not registered with Systems Manager. Check that the SSM agent is running and the instance profile includes AmazonSSMManagedInstanceCore.` };
  }
  if (inst.PingStatus !== 'Online') {
    return { mode: 'status', ok: false, state: 'OFFLINE', instanceId: cfg.instanceId, ssm: { pingStatus: inst.PingStatus }, message: `Instance ${cfg.instanceId} is ${inst.PingStatus} in Systems Manager, so it cannot be reached. Start the instance or check its network and SSM agent.` };
  }
  const p = plan(cfg, null);
  const res = await runOnInstance(clients.ssm, cfg, 'check service status', p.statusCommands, { ...opts.timing, executionTimeout: 60 });
  const kv = parseKv(res.stdout);
  let health = null;
  try { health = kv.health && kv.health !== 'UNREACHABLE' ? JSON.parse(kv.health) : null; } catch { health = null; }
  const active = kv.service === 'active';
  const ok = active && health?.status === 'ok';
  return {
    mode: 'status', ok, state: ok ? 'RUNNING' : active ? 'UNHEALTHY' : 'STOPPED',
    instanceId: cfg.instanceId, ssm: { pingStatus: inst.PingStatus, platform: inst.PlatformName ?? null }, service: kv.service ?? null, release: kv.release ?? null, health, publicUrl: cfg.publicUrl,
    message: ok ? 'The Office is running and healthy.' : active ? 'The service is running but the health check did not answer. Try a restart.' : `The service is "${kv.service ?? 'unknown'}". Try a restart.`
  };
}

/**
 * deploy({ mode }, { root, dataDir, clients?, configPath?, timing? }) -> JSON report.
 * Throws FactoryError on failure (deploy/restart/unconfigured). dry-run never touches AWS; status reports problems in the result.
 */
export async function deploy({ mode } = {}, opts = {}) {
  if (!MODES.includes(mode)) throw new FactoryError(`Unknown deploy mode "${mode}". Use one of: ${MODES.join(', ')}.`, 'BAD_MODE');
  const root = path.resolve(opts.root ?? HERE);
  const loaded = loadOfficeConfig(root, opts.configPath);
  const timing = { pollMs: 3000, timeoutMs: 20 * 60_000, ...(opts.timing ?? {}) };
  const o = { ...opts, timing };
  if (mode === 'dry-run') return dryRun(root, loaded);
  if (mode === 'status') return doStatus(loaded, o);
  if (mode === 'restart') return doRestart(loaded, o);
  return doDeploy(root, loaded, o);
}

// ---------------------------------------------------------------- CLI --------
function printReport(r) {
  if (r.mode === 'dry-run') {
    console.log('SAFI Office deployment: DRY RUN (no AWS calls are made)\n');
    for (const s of r.steps) console.log(`${s.n}. ${s.title}${s.awsCall ? '  [AWS call when deploying]' : ''}\n   ${s.detail}\n`);
    if (r.message) console.log(r.message);
    if (r.configured) console.log(`\nS3 key: ${r.plan.s3Key}\nSSM document: ${r.plan.ssmDocument}\nInstance: ${r.plan.instanceId}`);
    return;
  }
  if (r.mode === 'deploy') {
    for (const w of r.warnings ?? []) console.log(`WARNING: ${w}`);
    console.log(`PASS deploy: release ${r.release} is installed on ${r.ssm.instanceId}.\nBundle sha256: ${r.bundleSha256}\nS3: s3://${r.s3.bucket}/${r.s3.key}\nSSM command: ${r.ssm.commandId} (${r.ssm.status})${r.publicUrl ? `\nOpen: ${r.publicUrl}` : ''}\n\n${r.output}`);
    return;
  }
  if (r.mode === 'restart') {
    console.log(`PASS restart: the Office restarted and answered its health check.\n${r.output}`);
    return;
  }
  console.log(`${r.ok ? 'PASS' : 'FAIL'} status: ${r.state}. ${r.message}`);
  if (r.release) console.log(`Release: ${r.release}\nHealth: ${JSON.stringify(r.health)}`);
}

export async function main(argv) {
  const args = argv.slice(2);
  const flag = (n) => args.includes(n);
  const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const modes = MODES.filter((m) => flag(`--${m}`));
  if (modes.length !== 1) {
    console.error('Usage: node deploy-office.mjs --dry-run | --deploy | --status | --restart [--config config/office.json] [--json]');
    return 2;
  }
  try {
    const r = await deploy({ mode: modes[0] }, { root: HERE, configPath: val('--config') });
    if (flag('--json')) console.log(JSON.stringify(r, null, 2));
    else printReport(r);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof FactoryError)) throw e;
    console.error(`FAIL ${modes[0]}: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv).then((code) => { process.exitCode = code; });
}
