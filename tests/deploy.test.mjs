// Offline tests for Office deployment. AWS clients are stubs (no AWS call is ever made); the local Office
// simulation extracts the real bundle and runs it in office mode with its own data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as tar from 'tar';
import { buildBundle, collectBundleFiles, deploy, loadOfficeConfig, verifyManifest } from '../deploy-office.mjs';
import { prepareOfficeLocal, officeEnv } from '../scripts/office-local.mjs';
import { REPO } from './helpers.mjs';
import { stubLlm } from './office-stub.mjs';

const FAST = { pollMs: 1, timeoutMs: 2000 };
const GOOD_CFG = {
  region: 'ap-south-1', instanceId: 'i-0123456789abcdef0', bucket: 'customer-safi-office-bucket', prefix: 'safi-office/releases',
  secretParameterName: '/safi/office/anthropic-api-key', candidatePasscodeParameterName: '/safi/office/candidate-passcode',
  trainerPasscodeParameterName: '/safi/office/trainer-passcode', port: 8017, publicUrl: 'https://office.example.test'
};

/** A temp repo root with the runtime content, a fake client/dist, and decoys that must never be bundled. */
function makeBundleRoot({ withDist = true, decoys = true, config } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'safi-office-root-'));
  for (const d of ['lib', 'server', 'schemas', 'templates', 'skills', 'knowledge', 'registry', 'office']) cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  cpSync(path.join(REPO, 'config', 'office-grants.json'), path.join(root, 'config', 'office-grants.json'));
  for (const f of ['factory.mjs', 'package.json', 'package-lock.json']) cpSync(path.join(REPO, f), path.join(root, f));
  cpSync(path.join(REPO, 'fixtures'), path.join(root, 'fixtures'), { recursive: true }); // includes negative/ and adversarial-job.*, which must not be bundled
  if (withDist) {
    mkdirSync(path.join(root, 'client', 'dist', 'assets'), { recursive: true });
    writeFileSync(path.join(root, 'client', 'dist', 'index.html'), '<!doctype html><title>SAFI</title><div id="root"></div>');
    writeFileSync(path.join(root, 'client', 'dist', 'assets', 'app.js'), 'console.log("app");');
  }
  if (decoys) {
    const put = (rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
    put('drafts/draft-1.json', '{"draft":true}');
    put('data/instances/x/profile.json', '{"private":"resume"}');
    put('.env', 'ANTHROPIC_API_KEY=sk-ant-api03-REALLOOKINGKEY1234567890\n');
    put('.env.local', 'X=1\n');
    put('lib/.env', 'X=1\n');
    put('tests/a.test.mjs', 'x');
    put('release/old.tgz', 'x');
    put('docs/SOW-017.md', 'x');
    put('templates/unreleased-draft@9.9.9.json', '{"id":"unreleased-draft"}');
    put('server/leaked.pem', 'x');
    put('node_modules/foo/index.js', 'x');
  }
  if (config) {
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'office.json'), JSON.stringify(config, null, 2));
  }
  return root;
}
const rm = (p) => rmSync(p, { recursive: true, force: true });

async function listTar(file) {
  const names = [];
  await tar.t({ file, onReadEntry: (e) => names.push(e.path) });
  return names;
}

// ---------------------------------------------------------------- bundle ----
test('bundle: contains only runtime files; drafts, data, .env, tests, negative/adversarial fixtures, release, docs and unreleased templates are excluded; demo fixtures are included', async () => {
  const root = makeBundleRoot();
  try {
    const b = buildBundle({ root, gitSha: 'abc123def456' });
    const names = await listTar(b.bundlePath);
    for (const must of ['factory.mjs', 'package.json', 'package-lock.json', 'config/office-grants.json', 'client/dist/index.html', 'server/index.mjs', 'lib/runtime.mjs',
      'office/install.sh', 'office/fetch-secrets.sh', 'office/safi-jobcoach.service', 'registry/index.json', 'templates/safi.cs-graduate-jobseeker@1.0.0.json']) {
      assert.ok(names.includes(must), `bundle should contain ${must}`);
    }
    for (const f of ['alex-example.profile.json', 'alex-example.resume.txt', 'job-swe-entry.txt', 'job-swe-entry.meta.json', 'job-qa-data-entry.txt', 'job-qa-data-entry.meta.json']) {
      assert.ok(names.includes(`fixtures/${f}`), `bundle should contain fixtures/${f}`);
    }
    assert.ok(!names.some((n) => /^fixtures\/negative\//.test(n) || /adversarial-job/.test(n)), 'negative and adversarial fixtures stay out');
    assert.ok(names.some((n) => n.startsWith('skills/')) && names.some((n) => n.startsWith('knowledge/')) && names.some((n) => n.startsWith('schemas/')));
    for (const n of names) {
      assert.doesNotMatch(n, /^(drafts|data|tests|release|docs|node_modules)\//, `forbidden path in bundle: ${n}`);
      assert.doesNotMatch(n, /(^|\/)\.env/, `env file in bundle: ${n}`);
      assert.doesNotMatch(n, /\.pem$|unreleased-draft/, `key or draft in bundle: ${n}`);
    }
    // no key material in any byte of the bundle contents
    const buf = readFileSync(b.bundlePath);
    assert.ok(!buf.includes('REALLOOKINGKEY'));
    assert.equal(b.dir, path.join(root, 'release', 'office-bundle', 'abc123def456'));
    assert.ok(existsSync(b.manifestPath));
  } finally { rm(root); }
});

test('bundle: manifest per-file SHA-256 verifies against the extracted tree and the bundle hash; build is reproducible; tampering is caught', async () => {
  const root = makeBundleRoot({ decoys: false });
  const out = mkdtempSync(path.join(tmpdir(), 'safi-extract-'));
  try {
    const a = buildBundle({ root, gitSha: 'aaaa11112222' });
    const b = buildBundle({ root, gitSha: 'aaaa11112222', outDir: path.join(root, 'second') });
    assert.equal(a.bundleSha256, b.bundleSha256, 'same inputs give the same bundle hash');
    const manifest = JSON.parse(readFileSync(a.manifestPath, 'utf8'));
    assert.equal(manifest.bundle.sha256, (await import('node:crypto')).createHash('sha256').update(readFileSync(a.bundlePath)).digest('hex'));
    assert.equal(manifest.fileCount, manifest.files.length);
    tar.x({ file: a.bundlePath, cwd: out, sync: true });
    assert.deepEqual(verifyManifest(manifest, out), []);
    writeFileSync(path.join(out, 'lib', 'runtime.mjs'), '// tampered');
    assert.deepEqual(verifyManifest(manifest, out), [{ path: 'lib/runtime.mjs', problem: 'hash mismatch' }]);
  } finally { rm(root); rm(out); }
});

test('bundle: refuses secret-looking content and a missing client build, with plain messages', () => {
  const root = makeBundleRoot({ decoys: false });
  try {
    writeFileSync(path.join(root, 'lib', 'oops.mjs'), "const k = 'sk-ant-api03-abcdefghijklmnop1234';\n");
    assert.throws(() => buildBundle({ root, gitSha: 'x1' }), (e) => e.code === 'OFFICE_BUNDLE_SECRET' && /lib\/oops\.mjs/.test(e.message));
  } finally { rm(root); }
  const noDist = makeBundleRoot({ withDist: false, decoys: false });
  try {
    assert.throws(() => buildBundle({ root: noDist, gitSha: 'x2' }), (e) => e.code === 'OFFICE_BUNDLE_INCOMPLETE' && /run npm run build first/.test(e.message));
    assert.ok(collectBundleFiles(noDist).problems.length > 0);
  } finally { rm(noDist); }
});

// ---------------------------------------------------------------- dry run ---
test('dry-run with no config explains exactly which settings are missing and makes no AWS call', async () => {
  const root = makeBundleRoot({ decoys: false });
  const trap = { send: () => { throw new Error('AWS must not be called in a dry run'); } };
  try {
    const r = await deploy({ mode: 'dry-run' }, { root, clients: { s3: trap, ssm: trap } });
    assert.equal(r.ok, true);
    assert.equal(r.configured, false);
    assert.equal(r.awsCalls, 0);
    assert.deepEqual(r.missing.map((m) => m.field).sort(), ['bucket', 'candidatePasscodeParameterName', 'instanceId', 'region', 'secretParameterName', 'trainerPasscodeParameterName']);
    assert.match(r.message, /no AWS call was made/);
    assert.match(r.message, /instanceId: EC2 instance id/);
    assert.ok(r.steps.length >= 4 && r.steps.every((s) => s.title && s.detail));
    assert.equal(r.bundle.ok, true);
  } finally { rm(root); }
});

test('dry-run with a config prints the exact S3 key, SSM document and commands, still with no AWS call', async () => {
  const root = makeBundleRoot({ decoys: false, config: GOOD_CFG });
  const trap = { send: () => { throw new Error('AWS must not be called in a dry run'); } };
  try {
    const r = await deploy({ mode: 'dry-run' }, { root, clients: { s3: trap, ssm: trap } });
    assert.equal(r.configured, true);
    assert.equal(r.plan.ssmDocument, 'AWS-RunShellScript');
    assert.match(r.plan.s3Key, /^safi-office\/releases\/[A-Za-z0-9._-]+\/safi-office-[A-Za-z0-9._-]+\.tgz$/);
    assert.equal(r.plan.instanceId, GOOD_CFG.instanceId);
    const joined = r.plan.commands.join('\n');
    assert.match(joined, new RegExp(`aws s3 cp 's3://customer-safi-office-bucket/${r.plan.s3Key.replace(/[.]/g, '\\.')}'`));
    assert.match(joined, new RegExp(`sha256sum -c`));
    assert.match(joined, /office\/install\.sh/);
    assert.match(joined, new RegExp(`--sha '${r.bundle.bundleSha256}'`));
    assert.match(joined, /--secure-cookie 1/);
    assert.match(joined, /--trust-proxy 'false'/, 'the default is passed to the installer');
    assert.ok(r.steps.some((s) => /Upload/.test(s.title) && s.awsCall));
  } finally { rm(root); }
});

test('config: credentials in the file are rejected; bad values are named; example parses as incomplete placeholders', () => {
  const root = makeBundleRoot({ decoys: false, config: { ...GOOD_CFG, secretAccessKey: 'abc', port: 99999, bucket: 'Bad Bucket' } });
  try {
    const c = loadOfficeConfig(root);
    assert.equal(c.ok, false);
    assert.deepEqual(c.invalid.map((i) => i.field).sort(), ['bucket', 'port', 'secretAccessKey']);
    assert.match(c.invalid.find((i) => i.field === 'secretAccessKey').problem, /never be stored/);
  } finally { rm(root); }
});

// ---------------------------------------------------------------- deploy ----
function stubAws({ statuses = ['InProgress', 'Success'], s3Fail, sendFail } = {}) {
  const calls = [];
  let polls = 0;
  const s3 = { send: async (cmd) => { calls.push({ client: 's3', name: cmd.constructor.name, input: cmd.input }); if (s3Fail) throw s3Fail; return {}; } };
  const ssm = {
    send: async (cmd) => {
      calls.push({ client: 'ssm', name: cmd.constructor.name, input: cmd.input });
      if (sendFail) throw sendFail;
      switch (cmd.constructor.name) {
        case 'SendCommandCommand': return { Command: { CommandId: 'cmd-123' } };
        case 'GetCommandInvocationCommand': {
          const status = statuses[Math.min(polls++, statuses.length - 1)];
          return { Status: status, StandardOutputContent: status === 'Success' ? 'health={"status":"ok","mode":"office"}\n[install] INSTALL OK' : 'working', StandardErrorContent: status === 'Failed' ? 'INSTALL FAILED: Node.js 18 is too old' : '' };
        }
        case 'DescribeInstanceInformationCommand': return { InstanceInformationList: [{ PingStatus: 'Online', PlatformName: 'Amazon Linux' }] };
        default: throw new Error(`unexpected ${cmd.constructor.name}`);
      }
    }
  };
  return { clients: { s3, ssm }, calls };
}

test('deploy: uploads bundle and manifest to S3 with SSE, then SSM SendCommand AWS-RunShellScript on the instance, polls to Success', async () => {
  const root = makeBundleRoot({ decoys: false, config: GOOD_CFG });
  const { clients, calls } = stubAws();
  try {
    const r = await deploy({ mode: 'deploy' }, { root, clients, timing: FAST });
    assert.equal(r.ok, true);
    assert.equal(r.ssm.commandId, 'cmd-123');
    assert.match(r.output, /INSTALL OK/);
    assert.deepEqual(calls.map((c) => `${c.client}:${c.name}`), [
      's3:PutObjectCommand', 's3:PutObjectCommand', 'ssm:SendCommandCommand', 'ssm:GetCommandInvocationCommand', 'ssm:GetCommandInvocationCommand'
    ]);
    const [bundlePut, manifestPut, send, get] = calls;
    assert.equal(bundlePut.input.Bucket, GOOD_CFG.bucket);
    assert.equal(bundlePut.input.Key, r.s3.key);
    assert.equal(bundlePut.input.ServerSideEncryption, 'AES256');
    assert.ok(Buffer.isBuffer(bundlePut.input.Body) && bundlePut.input.Body.length > 1000);
    assert.equal(bundlePut.input.Metadata['safi-bundle-sha256'], r.bundleSha256);
    assert.equal(manifestPut.input.Key, r.s3.manifestKey);
    assert.equal(manifestPut.input.ServerSideEncryption, 'AES256');
    assert.deepEqual(send.input.InstanceIds, [GOOD_CFG.instanceId]);
    assert.equal(send.input.DocumentName, 'AWS-RunShellScript');
    const cmds = send.input.Parameters.commands.join('\n');
    assert.ok(cmds.includes(`s3://${GOOD_CFG.bucket}/${r.s3.key}`));
    assert.ok(cmds.includes(r.bundleSha256));
    assert.match(cmds, /bash "\$STAGE\/office\/install\.sh"/);
    assert.match(cmds, /--secret-param '\/safi\/office\/anthropic-api-key'/);
    assert.deepEqual(get.input, { CommandId: 'cmd-123', InstanceId: GOOD_CFG.instanceId });
    // the config has no secret values, and nothing secret is sent
    assert.doesNotMatch(JSON.stringify(calls.map((c) => c.input.Parameters ?? {})), /sk-ant|AKIA/);
  } finally { rm(root); }
});

test('deploy failure: a failed install is FAIL with the Office reason; S3 and AWS errors and missing config are never silent', async () => {
  const root = makeBundleRoot({ decoys: false, config: GOOD_CFG });
  try {
    await assert.rejects(deploy({ mode: 'deploy' }, { root, clients: stubAws({ statuses: ['InProgress', 'Failed'] }).clients, timing: FAST }),
      (e) => e.code === 'OFFICE_COMMAND_FAILED' && /Node\.js 18 is too old/.test(e.message) && /No release was marked as live/.test(e.message));
    const denied = Object.assign(new Error('User is not authorized to perform s3:PutObject'), { name: 'AccessDenied' });
    const s3Bad = stubAws({ s3Fail: denied });
    await assert.rejects(deploy({ mode: 'deploy' }, { root, clients: s3Bad.clients, timing: FAST }), (e) => e.code === 'OFFICE_AWS_ERROR' && /AccessDenied/.test(e.message) && /aws sso login/.test(e.message));
    assert.ok(!s3Bad.calls.some((c) => c.client === 'ssm'), 'SSM must not run after an upload failure');
    const noCreds = Object.assign(new Error('Could not load credentials from any providers'), { name: 'CredentialsProviderError' });
    await assert.rejects(deploy({ mode: 'deploy' }, { root, clients: stubAws({ s3Fail: noCreds }).clients, timing: FAST }), /No AWS credentials were found/);
    await assert.rejects(deploy({ mode: 'deploy' }, { root, clients: stubAws({ statuses: ['InProgress'] }).clients, timing: { pollMs: 1, timeoutMs: 30 } }), (e) => e.code === 'OFFICE_COMMAND_TIMEOUT');
    await assert.rejects(deploy({ mode: 'bogus' }, { root }), (e) => e.code === 'BAD_MODE');
  } finally { rm(root); }
  const bare = makeBundleRoot({ decoys: false });
  try {
    const a = stubAws();
    await assert.rejects(deploy({ mode: 'deploy' }, { root: bare, clients: a.clients }), (e) => e.code === 'OFFICE_NOT_CONFIGURED' && /instanceId/.test(e.message));
    await assert.rejects(deploy({ mode: 'restart' }, { root: bare, clients: a.clients }), (e) => e.code === 'OFFICE_NOT_CONFIGURED');
    assert.equal(a.calls.length, 0);
  } finally { rm(bare); }
});

test('restart and status: SSM commands target the safi-jobcoach service and report health; status says so when unconfigured or offline', async () => {
  const root = makeBundleRoot({ decoys: false, config: GOOD_CFG });
  try {
    const rs = stubAws({ statuses: ['Success'] });
    const r = await deploy({ mode: 'restart' }, { root, clients: rs.clients, timing: FAST });
    assert.equal(r.ok, true);
    assert.match(rs.calls[0].input.Parameters.commands.join('\n'), /systemctl restart safi-jobcoach/);
    assert.match(rs.calls[0].input.Parameters.commands.join('\n'), /127\.0\.0\.1:8017\/api\/v1\/health/);
    assert.match(r.health, /"status":"ok"/);

    const st = stubAws({ statuses: ['Success'] });
    st.clients.ssm.send = ((orig) => async (cmd) => {
      const out = await orig(cmd);
      if (cmd.constructor.name === 'GetCommandInvocationCommand') return { ...out, StandardOutputContent: 'service=active\nrelease=/opt/safi-office/releases/abc-1234\nhealth={"status":"ok","mode":"office"}' };
      return out;
    })(st.clients.ssm.send);
    const s = await deploy({ mode: 'status' }, { root, clients: st.clients, timing: FAST });
    assert.equal(s.ok, true);
    assert.equal(s.state, 'RUNNING');
    assert.equal(s.ssm.pingStatus, 'Online');
    assert.deepEqual(st.calls.map((c) => c.name).slice(0, 2), ['DescribeInstanceInformationCommand', 'SendCommandCommand']);
    assert.equal(st.calls[0].input.Filters[0].Key, 'InstanceIds');

    const off = { s3: {}, ssm: { send: async () => ({ InstanceInformationList: [{ PingStatus: 'ConnectionLost' }] }) } };
    const o = await deploy({ mode: 'status' }, { root, clients: off, timing: FAST });
    assert.equal(o.ok, false);
    assert.equal(o.state, 'OFFLINE');
    const none = await deploy({ mode: 'status' }, { root, clients: { s3: {}, ssm: { send: async () => ({ InstanceInformationList: [] }) } }, timing: FAST });
    assert.equal(none.state, 'NOT_REGISTERED');
  } finally { rm(root); }
  const bare = makeBundleRoot({ decoys: false });
  try {
    const s = await deploy({ mode: 'status' }, { root: bare });
    assert.equal(s.ok, false);
    assert.equal(s.state, 'NOT_CONFIGURED');
    assert.match(s.message, /not configured yet/);
  } finally { rm(bare); }
});

// ---------------------------------------------------------------- office scripts (run under bash with stubs) ----
const hasBash = (() => { try { return spawnSync('bash', ['-c', 'true']).status === 0; } catch { return false; } })();
const SKIP_BASH = hasBash ? false : 'bash is not available on this machine, so the install.sh / fetch-secrets.sh behaviour tests are skipped (install Git Bash or WSL to run them).';
const posix = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`) : p);
const symlinksWork = (() => {
  const d = mkdtempSync(path.join(tmpdir(), 'safi-sl-'));
  try { symlinkSync(d, path.join(d, 'l')); return true; } catch { return false; } finally { rmSync(d, { recursive: true, force: true }); }
})();
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

test('office scripts: unit file and static contract (one Node floor everywhere)', () => {
  const unit = readFileSync(path.join(REPO, 'office', 'safi-jobcoach.service'), 'utf8');
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStartPre=\+.*fetch-secrets\.sh/);
  assert.match(unit, /^ExecStart=\/usr\/bin\/env node server\/index\.mjs$/m, 'no node flags that an older supported Node might lack');
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.9.0');
  const install = readFileSync(path.join(REPO, 'office', 'install.sh'), 'utf8');
  assert.match(install, /-lt 22/, 'install.sh enforces the same Node floor as package.json');
  assert.match(install, /--ignore-scripts/);
  const doc = readFileSync(path.join(REPO, 'docs', 'AWS-REQUIREMENTS.md'), 'utf8');
  assert.match(doc, /Node\.js 22 LTS \(22\.9 or newer\) or Node 24 LTS/);
  assert.doesNotMatch(doc, /Node 20 or newer/);
});

/** A sandbox for running office/install.sh and fetch-secrets.sh under bash with fake aws/systemctl/npm/node/useradd/curl/id/chown on PATH. */
function makeSandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'safi-sh-'));
  const sb = { dir, stubs: path.join(dir, 'stubs'), app: path.join(dir, 'opt'), data: path.join(dir, 'data'), conf: path.join(dir, 'etc'), systemd: path.join(dir, 'systemd'), run: path.join(dir, 'run'), params: path.join(dir, 'params'), log: path.join(dir, 'calls.log') };
  for (const d of [sb.stubs, sb.params, sb.app]) mkdirSync(d, { recursive: true });
  writeFileSync(sb.log, '');
  const stub = (name, body) => writeFileSync(path.join(sb.stubs, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const L = '[ -n "${STUB_LOG:-}" ] && echo "$(basename "$0") $*" >> "$STUB_LOG"';
  stub('id', 'if [ "${1:-}" = "-u" ]; then echo 0; elif [ -n "${STUB_USER_MISSING:-}" ]; then exit 1; else exit 0; fi');
  for (const n of ['useradd', 'systemctl', 'chown', 'journalctl']) stub(n, `${L}\nexit 0`);
  stub('node', 'if [ "${1:-}" = "-v" ]; then echo "${STUB_NODE_VERSION:-v24.13.0}"; fi');
  stub('npm', `${L}\nif [ -n "\${STUB_NPM_FAIL:-}" ]; then echo "npm ERR! boom" >&2; exit 1; fi\nmkdir -p node_modules && echo ok > node_modules/.installed`);
  stub('curl', `${L}\nif [ -n "\${STUB_CURL_FAIL:-}" ]; then exit 22; fi\necho '{"status":"ok","mode":"office"}'`);
  // aws: "s3 cp s3://b/k DEST ..." copies the test bundle; "ssm get-parameter --name N ..." prints the file params/<N with / -> _>.
  stub('aws', `${L}
if [ "$1" = s3 ] && [ "$2" = cp ]; then cp "$STUB_BUNDLE" "$4"; exit 0; fi
if [ "$1" = ssm ]; then
  while [ $# -gt 0 ]; do if [ "$1" = --name ]; then n=$2; fi; shift; done
  f="$STUB_PARAMS/$(echo "$n" | tr / _)"
  [ -f "$f" ] || { echo "ParameterNotFound" >&2; exit 254; }
  cat "$f"; exit 0
fi
exit 1`);
  if (!symlinksWork) {
    // Windows without symlink privilege: emulate `ln -sfn TARGET LINK` / `readlink LINK` with a small file holding the target.
    stub('ln', 'while [ $# -gt 0 ]; do case "$1" in -*) ;; *) if [ -z "${t:-}" ]; then t=$1; else l=$1; fi ;; esac; shift; done\nprintf %s "$t" > "$l"');
    stub('readlink', 'if [ -f "$1" ]; then cat "$1"; else exit 1; fi');
  }
  sb.env = (extra = {}) => ({
    SAFI_TEST_PATH: `${posix(sb.stubs)}:/usr/bin:/bin`,
    HOME: posix(sb.dir),
    SAFI_APP_DIR: posix(sb.app), SAFI_OFFICE_DATA_DIR: posix(sb.data), SAFI_CONF_DIR: posix(sb.conf), SAFI_SYSTEMD_DIR: posix(sb.systemd), SAFI_RUN_DIR: posix(sb.run),
    SAFI_HEALTH_TRIES: '2', SAFI_HEALTH_SLEEP: '0',
    STUB_LOG: posix(sb.log), STUB_PARAMS: posix(sb.params),
    ...extra
  });
  sb.calls = () => readFileSync(sb.log, 'utf8').split('\n').filter(Boolean);
  sb.current = () => {
    const f = path.join(sb.app, 'current');
    try { return existsSync(f) ? (symlinksWork ? readlinkSync(f) : readFileSync(f, 'utf8')) : null; } catch { return null; }
  };
  // bash itself is found with the real PATH; the script then runs with only the stubs and the base system tools on PATH.
  sb.exec = (script, args, extra) => spawnSync('bash', ['-c', 'export PATH="$SAFI_TEST_PATH"; exec bash "$@"', 'safi-test', posix(path.join(REPO, 'office', script)), ...args], { env: { ...process.env, ...sb.env(extra) }, encoding: 'utf8' });
  return sb;
}

/** A tiny bundle with the real office/ scripts and a fake server, plus the args install.sh needs. */
function makeInstallBundle(sb, tag = 'one') {
  const src = path.join(sb.dir, `src-${tag}`);
  mkdirSync(path.join(src, 'server'), { recursive: true });
  cpSync(path.join(REPO, 'office'), path.join(src, 'office'), { recursive: true });
  writeFileSync(path.join(src, 'server', 'index.mjs'), `// ${tag}\n`);
  writeFileSync(path.join(src, 'package.json'), '{"name":"x","version":"1.0.0"}');
  writeFileSync(path.join(src, 'package-lock.json'), '{}');
  const file = path.join(sb.dir, `bundle-${tag}.tgz`);
  tar.c({ file, cwd: src, gzip: true, portable: true, noPax: true, mtime: new Date(0), sync: true }, ['office', 'server', 'package.json', 'package-lock.json']);
  const sha = sha256hex(readFileSync(file));
  const args = (release) => ['--bundle-file', posix(file), '--sha', sha, '--release', release, '--region', 'ap-south-1', '--port', '8017', '--host', '127.0.0.1', '--secure-cookie', '1',
    '--secret-param', '/safi/office/anthropic-api-key', '--candidate-param', '/safi/office/candidate-passcode', '--trainer-param', '/safi/office/trainer-passcode'];
  return { file, sha, args };
}
const setArg = (args, opt, val) => { const a = [...args]; a[a.indexOf(opt) + 1] = val; return a; };

test('install.sh: a wrong sha aborts before anything is extracted or changed', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const b = makeInstallBundle(sb);
    const r = sb.exec('install.sh', setArg(b.args('rel-1'), '--sha', 'f'.repeat(64)));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /SHA-256 mismatch/);
    assert.match(r.stderr, /Nothing was installed/);
    assert.ok(!existsSync(path.join(sb.app, 'releases')), 'no releases folder was created');
    assert.ok(!existsSync(path.join(sb.conf, 'office.conf')));
    assert.ok(!sb.calls().some((c) => /^(npm|systemctl|useradd)/.test(c)), sb.calls().join('\n'));
  } finally { rm(sb.dir); }
});

test('install.sh: refuses Node older than the 22.9 floor and unsafe argument values', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const b = makeInstallBundle(sb);
    for (const v of ['v20.19.0', 'v18.20.0', 'v22.8.0']) {
      const r = sb.exec('install.sh', b.args('rel-1'), { STUB_NODE_VERSION: v });
      assert.notEqual(r.status, 0, v);
      assert.match(r.stderr, /too old/);
    }
    for (const v of ['v22.9.0', 'v22.12.0', 'v24.13.0']) {
      const r = sb.exec('install.sh', b.args(`rel-${v}`), { STUB_NODE_VERSION: v });
      assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    }
    for (const [opt, val] of [['--host', '10.0.0.5'], ['--region', 'ap south'], ['--secret-param', '/x;rm -rf /'], ['--candidate-param', "/x'y"], ['--release', '../evil'], ['--trust-proxy', 'true'], ['--trust-proxy', '1;rm']]) {
      const r = sb.exec('install.sh', setArg(b.args('rel-z'), opt, val));
      assert.notEqual(r.status, 0, `${opt} ${val}`);
      assert.match(r.stderr, /INSTALL FAILED/);
    }
  } finally { rm(sb.dir); }
});

test('install.sh: fresh install creates the user, data dir, release, current, config (no secrets), unit, and restarts', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const b = makeInstallBundle(sb);
    const r = sb.exec('install.sh', b.args('rel-1'), { STUB_USER_MISSING: '1' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /INSTALL OK release=rel-1/);
    const rel = path.join(sb.app, 'releases', 'rel-1');
    assert.ok(existsSync(path.join(rel, 'server', 'index.mjs')));
    assert.ok(existsSync(path.join(rel, 'node_modules', '.installed')), 'npm ci ran in the release');
    assert.match(String(sb.current()), /releases[\\/]rel-1$/);
    assert.ok(existsSync(sb.data));
    assert.ok(existsSync(path.join(sb.systemd, 'safi-jobcoach.service')));
    const conf = readFileSync(path.join(sb.conf, 'office.conf'), 'utf8');
    assert.match(conf, /^SAFI_MODE=office$/m);
    assert.match(conf, /^COOKIE_SECURE=1$/m);
    assert.match(conf, /^TRUST_PROXY=false$/m, 'default: no proxy is trusted');
    assert.match(conf, /^SECRET_PARAM=\/safi\/office\/anthropic-api-key$/m);
    assert.doesNotMatch(conf, /sk-ant|PASSCODE=/);
    const calls = sb.calls();
    assert.ok(calls.some((c) => c.startsWith('useradd')), 'safi user created');
    assert.ok(calls.some((c) => /^npm ci --omit=dev --ignore-scripts/.test(c)));
    assert.ok(calls.includes('systemctl restart safi-jobcoach'));
    assert.deepEqual(readdirSync(path.join(sb.app, 'releases')), ['rel-1'], 'no staging folder left behind');
  } finally { rm(sb.dir); }
});

test('install.sh: re-deploying the live release keeps it intact (no delete, no re-install), refreshes config and restarts', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const b = makeInstallBundle(sb);
    assert.equal(sb.exec('install.sh', b.args('rel-1')).status, 0);
    const rel = path.join(sb.app, 'releases', 'rel-1');
    writeFileSync(path.join(rel, 'node_modules', 'sentinel'), 'still here'); // proves the folder is not rebuilt
    writeFileSync(sb.log, '');
    const r = sb.exec('install.sh', b.args('rel-1'));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /already live/);
    assert.equal(readFileSync(path.join(rel, 'node_modules', 'sentinel'), 'utf8'), 'still here');
    assert.match(String(sb.current()), /releases[\\/]rel-1$/);
    assert.ok(!sb.calls().some((c) => c.startsWith('npm')), 'npm ci not run again');
    assert.ok(sb.calls().includes('systemctl restart safi-jobcoach'));
    // an unhealthy redeploy of the same release must not delete it or invent a rollback target
    const bad = sb.exec('install.sh', b.args('rel-1'), { STUB_CURL_FAIL: '1' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no earlier release to roll back to/);
    assert.ok(existsSync(path.join(rel, 'server', 'index.mjs')), 'live release survives a failed health check');
    assert.match(String(sb.current()), /releases[\\/]rel-1$/);
  } finally { rm(sb.dir); }
});

test('install.sh: failed npm ci leaves the previous release live; an unhealthy new release rolls back to the genuinely previous one', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const one = makeInstallBundle(sb, 'one');
    assert.equal(sb.exec('install.sh', one.args('rel-1')).status, 0);
    const two = makeInstallBundle(sb, 'two');
    const failed = sb.exec('install.sh', two.args('rel-2'), { STUB_NPM_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /npm ci failed; nothing was changed and the release that was live is still live/);
    assert.match(String(sb.current()), /releases[\\/]rel-1$/, 'rel-1 is still live');
    assert.ok(existsSync(path.join(sb.app, 'releases', 'rel-1', 'server', 'index.mjs')));
    assert.deepEqual(readdirSync(path.join(sb.app, 'releases')), ['rel-1'], 'no half-built release or staging folder left');

    writeFileSync(sb.log, '');
    const unhealthy = sb.exec('install.sh', two.args('rel-2'), { STUB_CURL_FAIL: '1' });
    assert.notEqual(unhealthy.status, 0);
    assert.match(unhealthy.stderr, /rolled back to .*rel-1/);
    assert.match(String(sb.current()), /releases[\\/]rel-1$/, 'current points back at rel-1');
    assert.equal(sb.calls().filter((c) => c === 'systemctl restart safi-jobcoach').length, 2, 'restarted for rel-2, then again after the rollback');

    // a later healthy deploy of rel-2 reuses the already-built folder and succeeds
    const ok = sb.exec('install.sh', two.args('rel-2'));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(String(sb.current()), /releases[\\/]rel-2$/);
    assert.ok(existsSync(path.join(sb.app, 'releases', 'rel-1')), 'previous release kept for rollback');
  } finally { rm(sb.dir); }
});

function fetchSandbox(values) {
  const sb = makeSandbox();
  mkdirSync(sb.conf, { recursive: true });
  writeFileSync(path.join(sb.conf, 'office.conf'), 'AWS_REGION=ap-south-1\nSECRET_PARAM=/s/key\nCANDIDATE_PASSCODE_PARAM=/s/cand\nTRAINER_PASSCODE_PARAM=/s/train\n');
  writeFileSync(path.join(sb.params, '_s_key'), values[0]);
  writeFileSync(path.join(sb.params, '_s_cand'), values[1]);
  writeFileSync(path.join(sb.params, '_s_train'), values[2]);
  return sb;
}

test('fetch-secrets.sh: writes the env file with mode 0600 and leaves no temp file', { skip: SKIP_BASH }, () => {
  const sb = fetchSandbox(['sk-ant-test-key', 'cand pass', 'train#pass']);
  try {
    const r = sb.exec('fetch-secrets.sh', []);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(sb.run, 'env');
    assert.equal(readFileSync(out, 'utf8'), 'ANTHROPIC_API_KEY=sk-ant-test-key\nCANDIDATE_PASSCODE=cand pass\nTRAINER_PASSCODE=train#pass\n');
    assert.deepEqual(readdirSync(sb.run), ['env']);
    if (process.platform === 'win32') {
      // SKIPPED ON WINDOWS: NTFS has no POSIX modes, so 0600 cannot be observed here. Only the chmod call is asserted.
      assert.match(readFileSync(path.join(REPO, 'office', 'fetch-secrets.sh'), 'utf8'), /chmod 0600 "\$tmp"/);
    } else {
      assert.equal(statSync(out).mode & 0o777, 0o600);
    }
    assert.ok(sb.calls().some((c) => c.startsWith('chown safi:safi')));
  } finally { rm(sb.dir); }
});

test('fetch-secrets.sh: rejects quotes, backslashes, newlines and empty values; nothing is written', { skip: SKIP_BASH }, () => {
  const bads = { 'double quote': 'a"b', 'single quote': "a'b", backslash: 'a\\b', 'trailing backslash': 'abc\\', newline: 'a\nb', 'carriage return': 'a\rb' };
  for (const [what, bad] of Object.entries(bads)) {
    for (let slot = 0; slot < 3; slot++) {
      if (what !== 'backslash' && slot !== Object.keys(bads).indexOf(what) % 3) continue; // every slot is exercised via backslash; the others rotate
      const vals = ['good-key', 'good-cand', 'good-train'];
      vals[slot] = bad;
      const sb = fetchSandbox(vals);
      try {
        const r = sb.exec('fetch-secrets.sh', []);
        assert.notEqual(r.status, 0, `${what} in value ${slot} must be rejected`);
        assert.match(r.stderr, /newline, quote or backslash/, what);
        assert.deepEqual(existsSync(sb.run) ? readdirSync(sb.run) : [], [], `${what}: no env file and no temp file`);
      } finally { rm(sb.dir); }
    }
  }
  const sb = fetchSandbox(['', 'c', 't']);
  try {
    const r = sb.exec('fetch-secrets.sh', []);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /parameter is empty/);
    rmSync(path.join(sb.params, '_s_cand'));
    assert.notEqual(sb.exec('fetch-secrets.sh', []).status, 0, 'an unreadable parameter fails loudly');
  } finally { rm(sb.dir); }
});

// ---------------------------------------------------------------- local office
const PASS = { candidate: 'cand-pass-1', trainer: 'train-pass-1' };

async function startOffice(appDir, dataDir) {
  const { createApp } = await import(`file:///${path.join(appDir, 'server', 'app.mjs').replace(/\\/g, '/')}`);
  const app = createApp({ root: appDir, dataDir, mode: 'office', llm: stubLlm(), model: 'stub-model', passcodes: PASS, secret: 'test-secret', quiet: true, clientDist: path.join(appDir, 'client', 'dist') });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const api = async (method, p, { body, cookie } = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-SAFI-Request': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async (role, name) => (await api('POST', '/session', { body: { role, passcode: PASS[role], name } })).headers.get('set-cookie').split(';')[0];
  return { api, login, close: () => new Promise((r) => server.close(r)) };
}

test('local Office: bundle extracts and boots in office mode; instance + run survive a stop/start; authoring routes are 403', async () => {
  const root = makeBundleRoot({ decoys: false });
  const base = mkdtempSync(path.join(tmpdir(), 'safi-office-local-'));
  try {
    const { appDir, dataDir } = prepareOfficeLocal({ root, base, nodeModules: path.join(REPO, 'node_modules'), gitSha: 'localsim0001' });
    assert.ok(existsSync(path.join(appDir, 'server', 'index.mjs')));
    assert.ok(!existsSync(path.join(appDir, 'drafts')) && !existsSync(path.join(appDir, 'data')) && !existsSync(path.join(appDir, 'tests')));
    const T2 = 'safi.cs-graduate-jobseeker@1.0.0';
    const profile = JSON.parse(readFileSync(path.join(appDir, 'fixtures', 'alex-example.profile.json'), 'utf8'));

    let office = await startOffice(appDir, dataDir);
    let instanceId; let runId;
    try {
      assert.equal((await office.api('GET', '/health')).json.mode, 'office');
      const alex = await office.login('candidate', 'Alex');
      // The one-click demo works inside the extracted Office (fixtures come from the bundle, not the repo).
      const demo = await office.api('GET', '/fixtures/demo', { cookie: alex });
      assert.equal(demo.status, 200, demo.text);
      assert.equal(demo.json.profile.candidateName, 'Alex Example');
      assert.ok(demo.json.resumeText.length > 50 && demo.json.job.text.length > 50);
      const made = await office.api('POST', '/instances', { cookie: alex, body: { templateRef: T2, config: profile, name: 'Alex coach' } });
      assert.equal(made.status, 201, made.text);
      instanceId = made.json.instanceId;
      const started = await office.api('POST', `/instances/${instanceId}/runs`, { cookie: alex, body: { job: { text: 'Junior Software Engineer. Build and test web services in Python. Bachelor degree in Computer Science. Docker or AWS is a plus.', url: 'https://example.test/job', accessDate: '2026-11-03' } } });
      assert.equal(started.status, 202, started.text);
      for (let i = 0; i < 400; i++) {
        const j = (await office.api('GET', `/jobs/${started.json.jobId}`, { cookie: alex })).json;
        if (j.status === 'done') { assert.equal(j.result.status, 'PASS'); runId = j.result.runId; break; }
        assert.notEqual(j.status, 'failed', JSON.stringify(j));
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(runId, 'run finished');
      // authoring is closed in the Office
      const trainer = await office.login('trainer', 'Pat Trainer');
      for (const [m, p, body] of [['POST', '/drafts', {}], ['POST', '/drafts', { templateRef: T2, lesson: 'x' }], ['GET', '/drafts'], ['POST', '/drafts/safi.cs-graduate-jobseeker@1.0.1/approve', {}], ['POST', '/deploy', { mode: 'dry-run' }]]) {
        const r = await office.api(m, p, { cookie: trainer, body });
        assert.equal(r.status, 403, `${m} ${p}: ${r.text}`);
        assert.equal(r.json.error.code, 'OFFICE_MODE');
        assert.equal(r.json.error.message, 'Training is done in the SAFI Factory, not in the Office.');
      }
    } finally { await office.close(); }

    // "restart": a fresh server process-equivalent over the same data folder
    office = await startOffice(appDir, dataDir);
    try {
      const alex = await office.login('candidate', 'Alex');
      const list = (await office.api('GET', '/instances', { cookie: alex })).json.instances;
      assert.equal(list.length, 1);
      assert.equal(list[0].instanceId, instanceId);
      const runs = (await office.api('GET', `/instances/${instanceId}/runs`, { cookie: alex })).json.runs;
      assert.equal(runs.length, 1);
      assert.equal(runs[0].runId, runId);
      const rec = await office.api('GET', `/instances/${instanceId}/runs/${runId}`, { cookie: alex });
      assert.equal(rec.status, 200);
    } finally { await office.close(); }
    assert.ok(existsSync(path.join(dataDir, 'instances', instanceId, 'manifest.json')), 'data lives in the Office data folder, not in the app folder');
    assert.ok(!existsSync(path.join(appDir, 'data')));
  } finally { rm(root); rm(base); }
});

test('local Office: real server/index.mjs honours SAFI_MODE and SAFI_DATA_DIR from the environment', async () => {
  const root = makeBundleRoot({ decoys: false });
  const base = mkdtempSync(path.join(tmpdir(), 'safi-office-proc-'));
  try {
    const { appDir, dataDir } = prepareOfficeLocal({ root, base, nodeModules: path.join(REPO, 'node_modules'), gitSha: 'localsim0002' });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = { ...officeEnv({ dataDir, port, gitSha: 'localsim0002', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }), CANDIDATE_PASSCODE: PASS.candidate, TRAINER_PASSCODE: PASS.trainer, SESSION_SECRET: 'x'.repeat(40) };
    const child = spawn(process.execPath, ['server/index.mjs'], { cwd: appDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    try {
      let health = null;
      for (let i = 0; i < 100 && !health; i++) {
        try { health = await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json(); } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      assert.ok(health, `server did not start:\n${log}`);
      assert.equal(health.mode, 'office');
      assert.equal(health.gitSha, 'localsim0002');
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SAFI-Request': '1' }, body: JSON.stringify({ role: 'candidate', passcode: PASS.candidate, name: 'Alex' }) });
      assert.equal(r.status, 201);
    } finally { child.kill(); await new Promise((r) => child.on('exit', r)); }
    assert.ok(existsSync(dataDir), 'data dir from SAFI_DATA_DIR exists');
    assert.ok(!existsSync(path.join(appDir, 'data')), 'nothing was written to <app>/data');
  } finally { rm(root); rm(base); }
});

test('install.sh: --trust-proxy 1 is written to office.conf for the ALB topology', { skip: SKIP_BASH }, () => {
  const sb = makeSandbox();
  try {
    const b = makeInstallBundle(sb);
    const r = sb.exec('install.sh', [...b.args('rel-alb'), '--trust-proxy', '1'], { STUB_USER_MISSING: '1' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(readFileSync(path.join(sb.conf, 'office.conf'), 'utf8'), /^TRUST_PROXY=1$/m);
  } finally { rm(sb.dir); }
});
