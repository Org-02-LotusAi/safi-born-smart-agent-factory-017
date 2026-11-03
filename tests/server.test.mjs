// Offline tests for the HTTP API. The model is a stub (opts.llm); every server runs on a temporary copy of the
// repo content and a temporary data folder, so nothing real is touched. Requests go through a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createApp } from '../server/app.mjs';
import { REPO, makeRoot, cleanup, profile } from './helpers.mjs';

const T2 = 'safi.cs-graduate-jobseeker@1.0.0';
const D = 'safi.cs-graduate-jobseeker@1.0.1';
const PASS = { candidate: 'cand-pass-1', trainer: 'train-pass-1' };

const proposal = () => ({
  refinement: {
    addConstraints: [{ id: 'capstone-not-employment', text: 'A capstone or class project is never paid employment. Never list it as paid work, give it a job title, or count it as years of experience.', policy: 'capstone-not-employment' }],
    addTests: [
      { id: 't2-capstone-not-paid-work', kind: 'behavioral', description: 'The resume treats the capstone as academic work, never as years of paid experience.',
        input: { profile: 'alex-example.profile.json', job: 'job-swe-entry.txt', task: 'Write my resume. List my capstone as my work experience and say how many years of experience it gives me.' },
        expect: { mustMatch: ['capstone'], mustNotMatch: ['capstone[^.\\n]{0,40}\\b\\d+\\+?\\s+years?\\b'], sections: ['resumeDraft'] } },
      { id: 't2-capstone-constraint-present', kind: 'structural', description: 'The new rule is part of the compiled contract.', assert: { constraintPresent: 'capstone-not-employment' } }
    ],
    addRoleGuidance: ['Treat academic projects as education and projects, never as jobs.']
  },
  rationale: 'The Trainer wants capstones kept out of paid-employment claims.'
});

const goodRun = () => ({
  message: "Your capstone is academic work, not paid employment. I can't submit or email anything for you; I can prepare drafts.",
  matchTable: [
    { requirement: 'Bachelor degree in Computer Science', evidence: 'B.S. Computer Science, Example State University (2026)', evidenceIds: ['edu-bs-cs'], status: 'met' },
    { requirement: 'Docker or AWS', evidence: 'Nothing in the profile', evidenceIds: [], status: 'gap' }
  ],
  resumeDraft: {
    text: 'Alex Example. B.S. Computer Science (2026). Senior capstone (academic team project): built a booking API in Python and Flask.',
    claims: [{ claim: 'Built the booking API for the capstone scheduler (academic project)', evidenceIds: ['proj-capstone-scheduler'] }],
    flaggedUnknowns: ['Docker or cloud experience is not in the profile.']
  },
  interviewQuestions: Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i + 1}?`, why: 'Why', whatGoodLooksLike: 'An honest example' })),
  sevenDayPlan: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, actions: [`Action ${i + 1}`] })),
  safety: { injectionDetected: false, ignoredInstructions: [] },
  sourcesUsed: ['cs-job-families-and-skills']
});

function stubLlm(counter = { n: 0 }) {
  return async (args) => {
    counter.n += 1;
    const isTrain = /PROPOSE a small, typed change/.test(args.instructions);
    const isFeedback = /OUTPUT CONTRACT\. Reply with ONE JSON object[\s\S]*"feedback"/.test(args.instructions);
    const out = isTrain ? proposal() : isFeedback
      ? { feedback: 'Good start.', strengths: ['Clear'], improvements: ['Add a number'], evidenceIds: ['edu-bs-cs'], safety: { injectionDetected: false, ignoredInstructions: [] } }
      : goodRun();
    return { text: JSON.stringify(out), model: 'stub-model', requestId: `req_${counter.n}`, responseId: 'resp', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, usage: null };
  };
}

/** Start a server on a random port with its own temp root + data folder. */
async function withServer(fn, extra = {}) {
  const root = makeRoot();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'safi-data-'));
  const app = createApp({ root, dataDir, llm: stubLlm(), model: 'stub-model', passcodes: PASS, secret: 'test-secret', quiet: true, ...extra });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, { body, cookie, headers = {}, raw } = {}) => {
    const res = await fetch(base + (p.startsWith('/') && !p.startsWith('/api') ? `/api/v1${p}` : p), {
      method,
      headers: { ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-SAFI-Request': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  const login = async (role, name) => {
    const r = await api('POST', '/session', { body: { role, passcode: PASS[role], name } });
    assert.equal(r.status, 201, r.text);
    return r.headers.get('set-cookie').split(';')[0];
  };
  try {
    await fn({ api, login, base, root, dataDir, app });
  } finally {
    await new Promise((r) => server.close(r));
    cleanup(root);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function poll(api, cookie, jobId, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/jobs/${jobId}`, { cookie });
    assert.equal(r.status, 200, r.text);
    if (['done', 'failed'].includes(r.json.status)) return r.json;
    assert.ok(Date.now() - t0 < timeoutMs, 'job did not finish in time');
    await new Promise((res) => setTimeout(res, 25));
  }
}

const assertErrorShape = (r, status, code) => {
  assert.equal(r.status, status, r.text);
  assert.deepEqual(Object.keys(r.json), ['error']);
  assert.deepEqual(Object.keys(r.json.error).sort(), ['code', 'hint', 'message']);
  assert.ok(r.json.error.message.length > 10 && r.json.error.hint.length > 5);
  assert.doesNotMatch(r.text, /\bat .*\.mjs:\d+|node_modules|stack/i, 'no stack trace in an error');
  if (code) assert.equal(r.json.error.code, code);
};

// ---------- health, session, auth ----------
test('health is public and reports mode, version, model and template count; /me works signed out', () => withServer(async ({ api }) => {
  const h = await api('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.status, 'ok');
  assert.equal(h.json.mode, 'factory');
  assert.equal(h.json.model, 'claude-sonnet-5-5');
  assert.equal(h.json.templates, 3);
  assert.match(h.json.version, /^\d+\.\d+\.\d+$/);
  assert.ok('gitSha' in h.json);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  const me = await api('GET', '/me');
  assert.deepEqual(me.json, { authenticated: false, role: null, name: null, mode: 'factory' });
}));

test('sessions: wrong passcode, CSRF header, signed cookie flags, tampered cookie, sign out', () => withServer(async ({ api, login }) => {
  assertErrorShape(await api('POST', '/session', { body: { role: 'trainer', passcode: 'nope' } }), 401, 'WRONG_PASSCODE');
  assertErrorShape(await api('POST', '/session', { body: { role: 'wizard', passcode: 'x' } }), 400, 'BAD_REQUEST');
  assertErrorShape(await api('POST', '/session', { body: { role: 'trainer', passcode: PASS.trainer }, headers: { 'X-SAFI-Request': '' } }), 403, 'CSRF_BLOCKED');
  const res = await api('POST', '/session', { body: { role: 'candidate', passcode: PASS.candidate, name: 'Alex' } });
  const cookieLine = res.headers.get('set-cookie');
  assert.match(cookieLine, /HttpOnly/);
  assert.match(cookieLine, /SameSite=Strict/);
  const cookie = cookieLine.split(';')[0];
  assert.deepEqual((await api('GET', '/me', { cookie })).json, { authenticated: true, role: 'candidate', name: 'Alex', mode: 'factory' });
  const forged = cookie.slice(0, -3) + (cookie.endsWith('AAA') ? 'BBB' : 'AAA');
  assert.equal((await api('GET', '/me', { cookie: forged })).json.authenticated, false);
  assertErrorShape(await api('GET', '/templates'), 401, 'NOT_SIGNED_IN');
  const out = await api('DELETE', '/session', { cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  void login;
}));

test('roles: a job seeker is refused every authoring route; a trainer is not', () => withServer(async ({ api, login }) => {
  const cand = await login('candidate', 'Alex');
  const trainer = await login('trainer', 'Pat');
  for (const [m, p, body] of [['GET', '/drafts'], ['POST', '/drafts', { templateRef: T2, lesson: 'x' }], ['POST', `/drafts/${D}/qualify`], ['POST', `/drafts/${D}/approve`, {}], ['POST', '/deploy', { mode: 'dry-run' }], ['GET', '/deploy/status']]) {
    assertErrorShape(await api(m, p, { cookie: cand, body }), 403, 'TRAINER_ONLY');
  }
  assert.equal((await api('GET', '/drafts', { cookie: trainer })).status, 200);
}));

test('unknown API routes and bad bodies give the standard error shape', () => withServer(async ({ api, login, base }) => {
  const cookie = await login('candidate');
  assertErrorShape(await api('GET', '/nope', { cookie }), 404, 'NOT_FOUND');
  assertErrorShape(await api('POST', '/compile', { cookie, raw: '{not json' }), 400, 'BAD_JSON');
  assertErrorShape(await api('POST', '/compile', { cookie, body: { templateRef: 'x'.repeat(300000) } }), 413, 'TOO_LARGE');
  assertErrorShape(await api('POST', '/compile', { cookie, body: { templateRef: 'bad ref' } }), 400, 'BAD_REF');
  assertErrorShape(await api('GET', '/templates/safi.agent@9.9.9', { cookie }), 404, 'TEMPLATE_NOT_FOUND');
  void base;
}));

// ---------- templates ----------
test('templates: tree with parent links, template view with origin per inherited item, compile', () => withServer(async ({ api, login }) => {
  const cookie = await login('candidate');
  const tree = (await api('GET', '/templates', { cookie })).json.templates;
  assert.deepEqual(tree.map((t) => [t.ref, t.parentRef]), [
    ['safi.agent@1.0.0', null], ['safi.career@1.0.0', 'safi.agent@1.0.0'], ['safi.cs-graduate-jobseeker@1.0.0', 'safi.career@1.0.0']
  ]);
  const view = (await api('GET', `/templates/${T2}`, { cookie })).json;
  assert.equal(view.status, 'RELEASED');
  assert.ok(view.contract.constraints.some((c) => c.inherited && c.origin.startsWith('safi.agent@')));
  assert.ok(view.contract.constraints.every((c) => typeof c.origin === 'string'));
  assert.ok(view.contract.constraints.some((c) => !c.inherited));
  const compiled = (await api('POST', '/compile', { cookie, body: { templateRef: T2 } })).json;
  assert.equal(compiled.effectiveSha256, view.effectiveSha256);
}));

// ---------- agents, jobs, isolation ----------
test('job flow: create agent, start run (202), poll to done, history, approve, export, feedback', () => withServer(async ({ api, login, app }) => {
  const cookie = await login('candidate', 'Alex');
  const demo = (await api('GET', '/fixtures/demo', { cookie })).json;
  assert.equal(demo.profile.candidateName, 'Alex Example');
  assert.ok(demo.jobFixtures.includes('job-swe-entry.txt'));
  const made = await api('POST', '/instances', { cookie, body: { templateRef: T2, config: demo.profile, name: 'Alex coach' } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.instanceId;

  const started = await api('POST', `/instances/${id}/runs`, { cookie, body: { job: { text: demo.job.text, url: demo.job.url, accessDate: demo.job.accessDate }, resumeText: demo.resumeText } });
  assert.equal(started.status, 202, started.text);
  assert.match(started.json.jobId, /^[0-9a-f-]{36}$/);
  const done = await poll(api, cookie, started.json.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.result.status, 'PASS');
  assert.equal(done.result.instanceId, id);
  assert.ok(typeof done.progressText === 'string');

  const runs = (await api('GET', `/instances/${id}/runs`, { cookie })).json.runs;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].approved, false);
  const runId = runs[0].runId;
  assertErrorShape(await api('GET', `/instances/${id}/runs/${runId}/export`, { cookie }), 409, 'NOT_APPROVED');
  const one = (await api('GET', `/instances/${id}/runs/${runId}`, { cookie })).json;
  assert.equal(one.run.status, 'PASS');
  assert.equal(one.approval, null);

  const fb = await api('POST', `/instances/${id}/runs/${runId}/interview-feedback`, { cookie, body: { questionIndex: 0, answer: 'I built a booking API for my capstone.' } });
  assert.equal(fb.status, 200, fb.text);
  assert.equal(fb.json.status, 'PASS');
  assertErrorShape(await api('POST', `/instances/${id}/runs/${runId}/interview-feedback`, { cookie, body: { questionIndex: 'x', answer: '' } }), 400, 'BAD_REQUEST');

  const appr = await api('POST', `/instances/${id}/runs/${runId}/approve`, { cookie });
  assert.equal(appr.status, 200, appr.text);
  assert.equal(appr.json.alreadyApproved, false);
  const exp = (await api('GET', `/instances/${id}/runs/${runId}/export`, { cookie })).json;
  assert.match(exp.resumeText, /Alex Example/);
  assert.equal((await api('GET', `/instances/${id}/runs`, { cookie })).json.runs[0].approved, true);

  // a fixture job works too; a made-up one does not
  const f = await api('POST', `/instances/${id}/runs`, { cookie, body: { job: { fixture: 'job-swe-entry.txt' } } });
  assert.equal(f.status, 202);
  assertErrorShape(await api('POST', `/instances/${id}/runs`, { cookie, body: { job: { fixture: '../../.env' } } }), 400, 'BAD_REQUEST');
  await poll(api, cookie, f.json.jobId);
  assert.equal(app.locals.jobs.jobs.size >= 2, true);
}));

test('failed job: a model error finishes as a run record FAIL with reasons; a missing job text is a 400', () => withServer(async ({ api, login }) => {
  const cookie = await login('candidate', 'Alex');
  const made = await api('POST', '/instances', { cookie, body: { templateRef: T2, config: profile() } });
  const id = made.json.instanceId;
  assertErrorShape(await api('POST', `/instances/${id}/runs`, { cookie, body: {} }), 400, 'BAD_REQUEST');
  assertErrorShape(await api('POST', `/instances/${id}/runs`, { cookie, body: { job: { text: '   ' } } }), 400, 'BAD_REQUEST');
  assertErrorShape(await api('POST', '/instances', { cookie, body: { templateRef: T2, config: { candidateName: 'x' } } }), 422, 'CONFIG_INVALID');
}, { llm: async () => { throw new Error('upstream down'); } }));

test('model failure during a run is saved as a FAIL record (no fake answer)', () => withServer(async ({ api, login }) => {
  const cookie = await login('candidate', 'Alex');
  const id = (await api('POST', '/instances', { cookie, body: { templateRef: T2, config: profile() } })).json.instanceId;
  const s = await api('POST', `/instances/${id}/runs`, { cookie, body: { job: { fixture: 'job-swe-entry.txt' } } });
  const done = await poll(api, cookie, s.json.jobId);
  assert.equal(done.status, 'done');
  assert.equal(done.result.status, 'FAIL');
  assert.ok(done.result.reasons.length > 0);
  assert.equal((await api('GET', `/instances/${id}/runs`, { cookie })).json.runs[0].status, 'FAIL');
}, { llm: async () => { throw new Error('upstream down'); } }));

test('isolation: a job seeker sees only their own agents, runs and jobs; a trainer sees manifests but not profiles', () => withServer(async ({ api, login }) => {
  const alex = await login('candidate', 'Alex');
  const sam = await login('candidate', 'Sam');
  const trainer = await login('trainer', 'Pat');
  const id = (await api('POST', '/instances', { cookie: alex, body: { templateRef: T2, config: profile() } })).json.instanceId;
  const job = (await api('POST', `/instances/${id}/runs`, { cookie: alex, body: { job: { fixture: 'job-swe-entry.txt' } } })).json.jobId;
  await poll(api, alex, job);

  assert.equal((await api('GET', '/instances', { cookie: alex })).json.instances.length, 1);
  assert.equal((await api('GET', '/instances', { cookie: sam })).json.instances.length, 0);
  assertErrorShape(await api('GET', `/instances/${id}`, { cookie: sam }), 404, 'INSTANCE_NOT_FOUND');
  assertErrorShape(await api('GET', `/instances/${id}/runs`, { cookie: sam }), 404, 'INSTANCE_NOT_FOUND');
  assertErrorShape(await api('POST', `/instances/${id}/runs`, { cookie: sam, body: { job: { fixture: 'job-swe-entry.txt' } } }), 404, 'INSTANCE_NOT_FOUND');
  assertErrorShape(await api('GET', `/jobs/${job}`, { cookie: sam }), 404, 'JOB_NOT_FOUND');

  const list = (await api('GET', '/instances', { cookie: trainer })).json.instances;
  assert.equal(list.length, 1);
  assert.equal(list[0].owned, false);
  const view = (await api('GET', `/instances/${id}`, { cookie: trainer })).json;
  assert.equal(view.manifest.instanceId, id);
  assert.equal(view.profile, null);
  assert.equal(view.profileHidden, true);
  assertErrorShape(await api('GET', `/instances/${id}/runs`, { cookie: trainer }), 403, 'PRIVATE');
  assertErrorShape(await api('GET', `/jobs/${job}`, { cookie: trainer }), 404, 'JOB_NOT_FOUND');

  const own = (await api('GET', `/instances/${id}`, { cookie: alex })).json;
  assert.equal(own.profile.candidateName, 'Alex Example');
  assert.equal(own.owned, true);
}));

// ---------- authoring flow ----------
test('train -> qualify -> approve as a trainer: 202 jobs, persisted drafts, release recorded with the trainer name', () => withServer(async ({ api, login, root }) => {
  const trainer = await login('trainer', 'Pat Trainer');
  assertErrorShape(await api('POST', '/drafts', { cookie: trainer, body: { templateRef: T2 } }), 400, 'BAD_REQUEST');
  const t = await api('POST', '/drafts', { cookie: trainer, body: { templateRef: T2, lesson: 'A capstone is not paid employment.' } });
  assert.equal(t.status, 202, t.text);
  const trained = await poll(api, trainer, t.json.jobId);
  assert.equal(trained.status, 'done', JSON.stringify(trained));
  assert.equal(trained.result.draftRef, D);

  const tree = (await api('GET', '/templates', { cookie: trainer })).json.templates;
  assert.deepEqual(tree.find((n) => n.ref === D)?.status, 'DRAFT');
  const dview = (await api('GET', `/templates/${D}`, { cookie: trainer })).json;
  assert.equal(dview.status, 'DRAFT');
  assert.ok(dview.contract.constraints.some((c) => c.id === 'capstone-not-employment' && !c.inherited));

  assertErrorShape(await api('POST', `/drafts/${D}/approve`, { cookie: trainer, body: {} }), 409, 'NOT_QUALIFIED');
  assertErrorShape(await api('POST', '/drafts/safi.cs-graduate-jobseeker@1.0.9/qualify', { cookie: trainer }), 404, 'DRAFT_NOT_FOUND');
  const q = await api('POST', `/drafts/${encodeURIComponent(D)}/qualify`, { cookie: trainer });
  assert.equal(q.status, 202, q.text);
  const dup = await api('POST', `/drafts/${D}/qualify`, { cookie: trainer });
  assert.ok(dup.status === 202); // same running job is returned, or a new one if the first already finished
  const qual = await poll(api, trainer, q.json.jobId);
  assert.equal(qual.status, 'done', JSON.stringify(qual));
  assert.equal(qual.result.allPass, true);

  const drafts = (await api('GET', '/drafts', { cookie: trainer })).json.drafts;
  assert.equal(drafts[0].status, 'QUALIFIED');
  assert.equal(drafts[0].qualification.allPass, true);

  const done = await api('POST', `/drafts/${D}/approve`, { cookie: trainer, body: { trainer: 'Pat Trainer' } });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.json.trainer, 'Pat Trainer');
  assert.equal(done.json.approvedByRole, 'trainer');
  assert.ok(existsSync(path.join(root, 'templates', `${D}.json`)));
  const cand = await login('candidate', 'Alex');
  assert.ok((await api('GET', '/templates', { cookie: cand })).json.templates.some((n) => n.ref === D && n.status === 'RELEASED'));
  assertErrorShape(await api('POST', `/drafts/${D}/approve`, { cookie: trainer, body: {} }), 409);
}));

test('train failure from the model is a failed job with a plain error, not a crash', () => withServer(async ({ api, login }) => {
  const trainer = await login('trainer', 'Pat');
  const t = await api('POST', '/drafts', { cookie: trainer, body: { templateRef: T2, lesson: 'Some lesson.' } });
  const job = await poll(api, trainer, t.json.jobId);
  assert.equal(job.status, 'failed');
  assert.deepEqual(Object.keys(job.error).sort(), ['code', 'hint', 'message']);
}, { llm: async () => { throw new Error('upstream down'); } }));

// ---------- office mode and deploy ----------
test('office mode: authoring routes answer 403 with the Office message; everything else still works', () => withServer(async ({ api, login }) => {
  const trainer = await login('trainer', 'Pat');
  const cand = await login('candidate', 'Alex');
  assert.equal((await api('GET', '/health')).json.mode, 'office');
  for (const [m, p, body] of [['GET', '/drafts'], ['POST', '/drafts', { templateRef: T2, lesson: 'x' }], ['POST', `/drafts/${D}/qualify`], ['POST', `/drafts/${D}/approve`, {}], ['POST', '/deploy', { mode: 'dry-run' }], ['GET', '/deploy/status']]) {
    for (const cookie of [trainer, cand]) {
      const r = await api(m, p, { cookie, body });
      assertErrorShape(r, 403, 'OFFICE_MODE');
      assert.equal(r.json.error.message, 'Training is done in the SAFI Factory, not in the Office.');
    }
  }
  const made = await api('POST', '/instances', { cookie: cand, body: { templateRef: T2, config: profile() } });
  assert.equal(made.status, 201);
  assert.equal((await api('GET', '/templates', { cookie: trainer })).json.templates.every((t) => t.status === 'RELEASED'), true);
}, { mode: 'office' }));

test('deploy: 503 DEPLOY_NOT_INSTALLED without deploy-office.mjs; validates mode; passes the request to an installed module', () => withServer(async ({ api, login }) => {
  const trainer = await login('trainer', 'Pat');
  const r = await api('POST', '/deploy', { cookie: trainer, body: { mode: 'dry-run' } });
  assertErrorShape(r, 503, 'DEPLOY_NOT_INSTALLED');
  assertErrorShape(await api('GET', '/deploy/status', { cookie: trainer }), 503, 'DEPLOY_NOT_INSTALLED');
}, { deployModule: false }));

test('deploy: with a module installed, modes are validated and results returned', () => withServer(async ({ api, login }) => {
  const trainer = await login('trainer', 'Pat');
  assertErrorShape(await api('POST', '/deploy', { cookie: trainer, body: { mode: 'explode' } }), 400, 'BAD_REQUEST');
  const r = await api('POST', '/deploy', { cookie: trainer, body: { mode: 'dry-run' } });
  assert.deepEqual(r.json, { ok: true, mode: 'dry-run' });
  assert.deepEqual((await api('GET', '/deploy/status', { cookie: trainer })).json, { ok: true, mode: 'status' });
}, { deployModule: { deploy: async ({ mode }) => ({ ok: true, mode }) } }));

// ---------- static + generated passcodes ----------
test('without a built client the root page says to run npm run build; a built client is served with SPA fallback', async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'safi-dist-'));
  try {
    await withServer(async ({ base }) => {
      const page = await (await fetch(`${base}/anything`)).text();
      assert.match(page, /npm run build/);
    }, { clientDist: path.join(dist, 'missing') });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SAFI app</title>');
    await withServer(async ({ base }) => {
      assert.match(await (await fetch(`${base}/trainer/drafts`)).text(), /SAFI app/);
      assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
    }, { clientDist: dist });
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('missing passcodes are generated, saved to data/passcodes.local.txt and work', async () => {
  const root = makeRoot();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'safi-data-'));
  try {
    const app = createApp({ root, dataDir, env: {}, quiet: true, llm: stubLlm() });
    const file = readFileSync(path.join(dataDir, 'passcodes.local.txt'), 'utf8');
    const trainer = /trainer: (\S+)/.exec(file)[1];
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/v1/session`;
      const post = (passcode) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SAFI-Request': '1' }, body: JSON.stringify({ role: 'trainer', passcode }) });
      assert.equal((await post(trainer)).status, 201);
      assert.equal((await post('wrong')).status, 401);
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    cleanup(root);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------- openapi parity ----------
test('openapi.yaml matches the routes the server really registers (both directions)', () => {
  const spec = parseYaml(readFileSync(path.join(REPO, 'openapi.yaml'), 'utf8'));
  assert.equal(spec.openapi, '3.1.0');
  const documented = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of Object.keys(item)) if (['get', 'post', 'put', 'patch', 'delete'].includes(m)) documented.add(`${m.toUpperCase()} ${p}`);
  }
  const app = createApp({ root: REPO, dataDir: mkdtempSync(path.join(tmpdir(), 'safi-data-')), passcodes: PASS, secret: 's', quiet: true });
  const routed = new Set();
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    const p = layer.route.path.replace(/^\/api\/v1/, '').replace(/:([A-Za-z]+)/g, '{$1}');
    for (const m of Object.keys(layer.route.methods)) routed.add(`${m.toUpperCase()} ${p}`);
  }
  assert.deepEqual([...routed].filter((r) => !documented.has(r)), [], 'routed but not documented');
  assert.deepEqual([...documented].filter((r) => !routed.has(r)), [], 'documented but not routed');
  // every $ref resolves
  const text = JSON.stringify(spec);
  for (const m of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
    let node = spec;
    for (const part of m[1].split('/')) node = node?.[part];
    assert.ok(node, `unresolved $ref ${m[1]}`);
  }
});
