// Offline tests for Office deployment. AWS clients are stubs (no AWS call is ever made); the local Office
// simulation extracts the real bundle and runs it in office mode with its own data folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
    put('fixtures/alex-example.profile.json', '{}');
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
test('bundle: contains only runtime files; drafts, data, .env, tests, fixtures, release, docs and unreleased templates are excluded', async () => {
  const root = makeBundleRoot();
  try {
    const b = buildBundle({ root, gitSha: 'abc123def456' });
    const names = await listTar(b.bundlePath);
    for (const must of ['factory.mjs', 'package.json', 'package-lock.json', 'config/office-grants.json', 'client/dist/index.html', 'server/index.mjs', 'lib/runtime.mjs',
      'office/install.sh', 'office/fetch-secrets.sh', 'office/safi-jobcoach.service', 'registry/index.json', 'templates/safi.cs-graduate-jobseeker@1.0.0.json']) {
      assert.ok(names.includes(must), `bundle should contain ${must}`);
    }
    assert.ok(names.some((n) => n.startsWith('skills/')) && names.some((n) => n.startsWith('knowledge/')) && names.some((n) => n.startsWith('schemas/')));
    for (const n of names) {
      assert.doesNotMatch(n, /^(drafts|data|tests|fixtures|release|docs|node_modules)\//, `forbidden path in bundle: ${n}`);
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

test('office scripts: shell syntax is valid and install.sh enforces the Node 20+ prerequisite and sha check', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const f of ['install.sh', 'fetch-secrets.sh']) {
    const r = spawnSync('bash', ['-n', path.join(REPO, 'office', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  const install = readFileSync(path.join(REPO, 'office', 'install.sh'), 'utf8');
  assert.match(install, /-ge 20/);
  assert.match(install, /Node\.js .* is too old/);
  assert.match(install, /SHA-256 mismatch/);
  assert.match(install, /npm ci --omit=dev/);
  assert.match(install, /current\.new/);
  const unit = readFileSync(path.join(REPO, 'office', 'safi-jobcoach.service'), 'utf8');
  assert.match(unit, /Restart=always/);
  assert.match(unit, /ExecStartPre=\+.*fetch-secrets\.sh/);
  const fetch = readFileSync(path.join(REPO, 'office', 'fetch-secrets.sh'), 'utf8');
  assert.match(fetch, /--with-decryption/);
  assert.match(fetch, /chmod 0600/);
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
    const profile = JSON.parse(readFileSync(path.join(REPO, 'fixtures', 'alex-example.profile.json'), 'utf8'));

    let office = await startOffice(appDir, dataDir);
    let instanceId; let runId;
    try {
      assert.equal((await office.api('GET', '/health')).json.mode, 'office');
      const alex = await office.login('candidate', 'Alex');
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
