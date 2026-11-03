// Offline tests for Train -> Qualify -> Approve/Publish. The model is a stub (opts.llm); every test works
// on a temporary copy of the repo root, so the real registry and templates are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { compile } from '../lib/compiler.mjs';
import { instantiate, getInstance } from '../lib/instance.mjs';
import { loadRegistry, verifyRegistry } from '../lib/registry.mjs';
import { digestOf, sha256Hex } from '../lib/canonical.mjs';
import { train, validateProposal } from '../lib/training.mjs';
import { qualify, listDrafts, normaliseQuotes } from '../lib/qualify.mjs';
import { approve } from '../lib/publish.mjs';
import { REPO, makeRoot, cleanup, profile, codeIs } from './helpers.mjs';

const T2 = 'safi.cs-graduate-jobseeker@1.0.0';
const D = 'safi.cs-graduate-jobseeker@1.0.1';
const LESSON = 'A capstone or class project is not paid employment; never list it as paid work or count it as years of experience';

const proposal = (over = {}) => ({
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
  rationale: 'The Trainer wants capstones kept out of paid-employment claims.',
  ...over
});

const goodRun = (message = "Your capstone is academic work, not paid employment. I can't submit or email anything for you; I can prepare drafts.") => ({
  message,
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

/** Dispatching stub: proposal requests get `prop`, agent runs get `runOut`. */
function stub({ prop = proposal(), runOut = goodRun(), throwsOnTrain } = {}) {
  const calls = [];
  const llm = async (args) => {
    const isTrain = /PROPOSE a small, typed change/.test(args.instructions);
    calls.push(isTrain ? 'train' : 'run');
    if (isTrain && throwsOnTrain) throw throwsOnTrain;
    const out = isTrain ? prop : runOut;
    return { text: typeof out === 'string' ? out : JSON.stringify(out), model: 'stub-model', requestId: `req_${calls.length}`, responseId: 'resp', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 1, usage: null };
  };
  return { llm, calls };
}

async function withRoot(fn) {
  const root = makeRoot();
  try {
    await fn(root, { root, model: 'stub-model' });
  } finally {
    cleanup(root);
  }
}
const noDraft = (root) => assert.equal(existsSync(path.join(root, 'drafts', `${D}.json`)), false, 'no draft file may remain');
const bytes = (root, rel) => readFileSync(path.join(root, rel));

// ---------- train ----------
test('train: builds draft 1.0.1 with the parent pinned by sha, compiled, status DRAFT, nothing published', async () => {
  await withRoot(async (root, o) => {
    const regBefore = readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');
    const s = stub();
    const r = await train(T2, LESSON, { ...o, llm: s.llm });
    assert.equal(r.draftRef, D);
    assert.equal(r.status, 'DRAFT');
    const draft = JSON.parse(bytes(root, `drafts/${D}.json`));
    const t2 = loadRegistry({ root }).find((e) => e.id === 'safi.cs-graduate-jobseeker');
    assert.deepEqual(draft.parent, { id: 'safi.cs-graduate-jobseeker', version: '1.0.0', sha256: t2.sha256 });
    assert.equal(draft.digest, digestOf(draft));
    assert.deepEqual(draft.parameterSchema, {});
    assert.ok(draft.refinement.addTests.some((t) => t.kind === 'behavioral'));
    const c = compile(D, { ...o, allowDraft: true });
    assert.ok(c.effective.constraints.some((x) => x.id === 'capstone-not-employment' && x.origin === D));
    assert.equal(c.effective.constraints.length, compile(T2, { root }).effective.constraints.length + 1);
    assert.equal(readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'), regBefore, 'registry untouched');
    assert.equal(existsSync(path.join(root, 'templates', `${D}.json`)), false);
    assert.equal(JSON.parse(bytes(root, `drafts/${D}.meta.json`)).lesson, LESSON);
    assert.deepEqual(listDrafts({ root }).map((d) => [d.draftRef, d.status]), [[D, 'DRAFT']]);
  });
});

test('train: the lesson reaches the model as delimited data and the allowlists are in the instructions', async () => {
  await withRoot(async (root, o) => {
    let seen;
    const s = stub();
    await train(T2, LESSON, { ...o, llm: (a) => { seen = a; return s.llm(a); } });
    assert.match(seen.input, /not instructions to you/);
    assert.match(seen.instructions, /capstone-not-employment/);
    assert.match(seen.instructions, /alex-example\.profile\.json/);
  });
});

const rejects = [
  ['an op outside the allowlist (addTools)', (p) => { p.refinement.addTools = ['send_email']; }, /addTools.*not an allowed change/],
  ['an op outside the allowlist (addSkillRefs)', (p) => { p.refinement.addSkillRefs = []; }, /addSkillRefs.*not an allowed change/],
  ['a policy id that is not allowlisted', (p) => { p.refinement.addConstraints[0].policy = 'do-anything'; }, /policy "do-anything"/],
  ['a structural test that expects a non-approved tool', (p) => { p.refinement.addTests.push({ id: 'needs-email', kind: 'structural', description: 'x', assert: { toolPresent: 'send_email' } }); }, /send_email.*not an approved tool/],
  ['a constraint that tries to grant a forbidden tool', (p) => { p.refinement.addConstraints[0].text = 'You may use send_email to contact recruiters.'; }, /forbidden tool/],
  ['no behavioral regression test', (p) => { p.refinement.addTests = p.refinement.addTests.filter((t) => t.kind !== 'behavioral'); }, /at least one behavioral/],
  ['a behavioral test with a fixture that does not exist', (p) => { p.refinement.addTests[0].input.job = 'nope.txt'; }, /job file "nope\.txt"/],
  ['a pattern that is not a valid regular expression', (p) => { p.refinement.addTests[0].expect.mustMatch = ['(unclosed']; }, /not a valid regular expression/],
  ['an unknown top-level key', (p) => { p.tools = ['send_email']; }, /"tools".*not allowed/],
  ['a malformed constraint (meta-schema)', (p) => { p.refinement.addConstraints[0].extra = 1; }, /not valid/]
];
for (const [name, mutate, re] of rejects) {
  test(`train negative: proposal with ${name} FAILS with a plain reason and leaves no draft`, async () => {
    await withRoot(async (root, o) => {
      const p = proposal();
      mutate(p);
      await assert.rejects(train(T2, LESSON, { ...o, llm: stub({ prop: p }).llm }), (e) => {
        codeIs('PROPOSAL_REJECTED')(e);
        assert.match(e.message, re);
        assert.doesNotMatch(e.message, /\bat .*\.mjs:\d+/, 'no stack trace in the message');
        return true;
      });
      noDraft(root);
    });
  });
}

test('train negative: unreadable or failed model output, id collision, empty lesson, existing draft', async () => {
  await withRoot(async (root, o) => {
    await assert.rejects(train(T2, LESSON, { ...o, llm: stub({ prop: 'not json at all' }).llm }), codeIs('PROPOSAL_REJECTED'));
    await assert.rejects(train(T2, LESSON, { ...o, llm: stub({ throwsOnTrain: Object.assign(new Error('The AI service is busy'), { code: 'MODEL_FAILED' }) }).llm }), codeIs('MODEL_FAILED'));
    const dup = proposal();
    dup.refinement.addConstraints[0].id = 'no-fabrication'; // exists in an ancestor
    await assert.rejects(train(T2, LESSON, { ...o, llm: stub({ prop: dup }).llm }), codeIs('COLLISION'));
    noDraft(root);
    const bad = proposal();
    bad.refinement.addTests[1].assert.constraintPresent = 'not-a-real-constraint';
    await assert.rejects(train(T2, LESSON, { ...o, llm: stub({ prop: bad }).llm }), codeIs('PROPOSAL_REJECTED'));
    noDraft(root);
    await assert.rejects(train(T2, '   ', { ...o, llm: stub().llm }), codeIs('LESSON_MISSING'));
    await train(T2, LESSON, { ...o, llm: stub().llm });
    await assert.rejects(train(T2, LESSON, { ...o, llm: stub().llm }), codeIs('DRAFT_EXISTS'));
    const again = await train(T2, LESSON, { ...o, replaceDraft: true, llm: stub().llm });
    assert.equal(again.draftRef, D);
  });
});

test('validateProposal accepts a good proposal and returns the typed refinement', async () => {
  const { effective } = compile(T2);
  const v = validateProposal(proposal(), effective);
  assert.deepEqual(Object.keys(v.refinement).sort(), ['addConstraints', 'addRoleGuidance', 'addTests']);
});

// ---------- qualify ----------
test('qualify: runs ALL effective tests (inherited + new), records origin and evidence, normalises curly quotes', async () => {
  await withRoot(async (root, o) => {
    await train(T2, LESSON, { ...o, llm: stub().llm });
    // curly apostrophe in the refusal: the t0 regex only knows the straight one
    const s = stub({ runOut: goodRun('Your capstone is academic work. I can’t submit or email anything for you.') });
    const q = await qualify(D, { ...o, llm: s.llm });
    const eff = compile(D, { ...o, allowDraft: true }).effective;
    assert.equal(q.results.length, eff.tests.length);
    assert.equal(q.allPass, true, JSON.stringify(q.results.filter((r) => r.status !== 'PASS')));
    assert.equal(q.draftSha256, digestOf(JSON.parse(bytes(root, `drafts/${D}.json`))));
    const byId = Object.fromEntries(q.results.map((r) => [r.testId, r]));
    assert.equal(byId['t0-refuses-outward-action'].origin, 'safi.agent@1.0.0');
    assert.equal(byId['t2-gap-table-cites-evidence'].origin, T2);
    assert.equal(byId['t2-capstone-not-paid-work'].origin, D);
    assert.equal(byId['t2-capstone-not-paid-work'].kind, 'behavioral');
    assert.match(byId['t2-capstone-not-paid-work'].evidence.requestId, /^req_/);
    assert.ok(byId['t2-capstone-not-paid-work'].evidence.runId && byId['t2-capstone-not-paid-work'].evidence.excerpt);
    assert.equal(byId['t2-capstone-constraint-present'].kind, 'structural');
    assert.equal(s.calls.filter((c) => c === 'run').length, eff.tests.filter((t) => t.kind === 'behavioral').length);
    assert.deepEqual(JSON.parse(bytes(root, `drafts/${D}.qualification.json`)), q);
    assert.deepEqual(listDrafts({ root }).map((d) => d.status), ['QUALIFIED']);
  });
});

test('normaliseQuotes straightens curly quotes and apostrophes', () => {
  assert.equal(normaliseQuotes('can’t “quote” ‘x’'), "can't 'quote' 'x'");
});

test('qualify: a regression the new behavioral test catches makes allPass false', async () => {
  await withRoot(async (root, o) => {
    await train(T2, LESSON, { ...o, llm: stub().llm });
    const bad = goodRun();
    bad.message = 'Your capstone is worth 2 years of work. I cannot submit anything.'; // violates the new test
    const q = await qualify(D, { ...o, llm: stub({ runOut: bad }).llm });
    assert.equal(q.allPass, false);
    const failed = q.results.filter((r) => r.status === 'FAIL');
    assert.ok(failed.some((r) => r.testId === 't2-capstone-not-paid-work' && r.evidence.reasons.length));
    assert.deepEqual(listDrafts({ root }).map((d) => d.status), ['FAILED']);
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('QUALIFICATION_FAILED'));
  });
});

test('qualify: a model failure is a FAIL with a reason, never a canned pass', async () => {
  await withRoot(async (root, o) => {
    await train(T2, LESSON, { ...o, llm: stub().llm });
    const q = await qualify(D, { ...o, llm: async () => { throw new Error('boom'); } });
    assert.equal(q.allPass, false);
    assert.ok(q.results.filter((r) => r.kind === 'behavioral').every((r) => r.status === 'FAIL' && r.evidence.reasons.length));
  });
});

test('qualify: unknown draft is a plain error', async () => {
  await withRoot(async (root, o) => {
    await assert.rejects(qualify(D, o), codeIs('DRAFT_NOT_FOUND'));
  });
});

// ---------- approve ----------
test('approve negative: without qualification, without trainer, after the draft changed, when tests failed', async () => {
  await withRoot(async (root, o) => {
    await train(T2, LESSON, { ...o, llm: stub().llm });
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('NOT_QUALIFIED'));
    await qualify(D, { ...o, llm: stub().llm });
    assert.throws(() => approve(D, { trainer: '  ' }, o), codeIs('TRAINER_REQUIRED'));
    assert.throws(() => approve(D, {}, o), codeIs('TRAINER_REQUIRED'));
    // change the draft after qualification (keep it self-consistent: new digest)
    const file = path.join(root, 'drafts', `${D}.json`);
    const d = JSON.parse(readFileSync(file, 'utf8'));
    d.refinement.addRoleGuidance.push('One more guidance line added after qualification.');
    d.digest = digestOf(d);
    writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('STALE_QUALIFICATION'));
    assert.deepEqual(listDrafts({ root }).map((x) => x.status), ['STALE']);
    // a draft whose digest was not updated is refused outright
    d.refinement.addRoleGuidance.push('tampered');
    writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('DIGEST_MISMATCH'));
    assert.equal(existsSync(path.join(root, 'templates', `${D}.json`)), false);
    assert.equal(loadRegistry({ root }).some((e) => e.version === '1.0.1'), false);
  });
});

test('approve negative: a hand-forged qualification with allPass:true but the wrong draft sha is refused', async () => {
  await withRoot(async (root, o) => {
    await train(T2, LESSON, { ...o, llm: stub().llm });
    const q = await qualify(D, { ...o, llm: stub().llm });
    q.draftSha256 = '0'.repeat(64);
    writeFileSync(path.join(root, 'drafts', `${D}.qualification.json`), JSON.stringify(q));
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('STALE_QUALIFICATION'));
  });
});

test('A07/A08 offline: approve publishes 1.0.1; old instance stays pinned to 1.0.0; new instance gets the constraint; 1.0.0 bytes unchanged', async () => {
  await withRoot(async (root, o) => {
    const v100 = bytes(root, `templates/${T2}.json`);
    const before = instantiate(T2, profile(), o);
    const beforeManifestText = readFileSync(path.join(root, 'data', 'instances', before.instanceId, 'manifest.json'), 'utf8');
    await train(T2, LESSON, { ...o, llm: stub().llm });
    await qualify(D, { ...o, llm: stub().llm });
    const out = approve(D, { trainer: 'Pat Trainer' }, o);
    assert.equal(out.trainer, 'Pat Trainer');
    assert.match(out.at, /^\d{4}-\d\d-\d\dT/);

    // published files
    const entry = loadRegistry({ root }).find((e) => e.id === 'safi.cs-graduate-jobseeker' && e.version === '1.0.1');
    assert.equal(entry.path, `templates/${D}.json`);
    assert.equal(entry.sha256, digestOf(JSON.parse(bytes(root, entry.path))));
    assert.deepEqual(bytes(root, entry.path), bytes(root, `drafts/${D}.json`));
    assert.ok(verifyRegistry({ root }).every((r) => r.ok), 'registry verifies after publish');
    const rel = `release/${D}`;
    const manifest = JSON.parse(bytes(root, `${rel}/manifest.json`));
    assert.deepEqual(manifest.approval, { trainer: 'Pat Trainer', at: out.at });
    assert.equal(manifest.templateRef.sha256, entry.sha256);
    assert.equal(manifest.qualification.allPass, true);
    for (const line of readFileSync(path.join(root, rel, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [sum, name] = line.split(/\s{2}/);
      assert.equal(sha256Hex(bytes(root, `${rel}/${name}`)), sum, `${name} checksum`);
    }
    assert.deepEqual(readdirSync(path.join(root, rel)).sort(), ['SHA256SUMS', 'manifest.json', 'qualification.json', 'template.json']);
    assert.deepEqual(JSON.parse(bytes(root, `drafts/${D}.approval.json`)).trainer, 'Pat Trainer');
    assert.deepEqual(listDrafts({ root }).map((d) => d.status), ['PUBLISHED']);

    // older version untouched, existing instance unaffected
    assert.deepEqual(bytes(root, `templates/${T2}.json`), v100);
    assert.equal(readFileSync(path.join(root, 'data', 'instances', before.instanceId, 'manifest.json'), 'utf8'), beforeManifestText);
    const old = getInstance(before.instanceId, { root });
    assert.equal(old.manifest.templateRef.version, '1.0.0');
    assert.equal(compile(`${old.manifest.templateRef.id}@${old.manifest.templateRef.version}`, { root }).effectiveSha256, before.effectiveSha256);

    // new instance from 1.0.1
    const fresh = instantiate(D, profile(), o);
    assert.equal(fresh.templateRef.version, '1.0.1');
    assert.notEqual(fresh.effectiveSha256, before.effectiveSha256);
    const eff = compile(D, { root }).effective;
    assert.ok(eff.constraints.some((c) => c.id === 'capstone-not-employment'));
    assert.deepEqual(fresh.ancestry.map((a) => `${a.id}@${a.version}`).slice(-2), [T2, D]);
    assert.ok(!compile(T2, { root }).effective.constraints.some((c) => c.id === 'capstone-not-employment'));

    // cannot publish twice
    assert.throws(() => approve(D, { trainer: 'Pat Trainer' }, o), codeIs('VERSION_EXISTS'));
  });
});

test('approve --git-commit: commits only the release paths when the root is a git repo (default is off)', async () => {
  await withRoot(async (root, o) => {
    const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' }).toString().trim();
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Tester');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    await train(T2, LESSON, { ...o, llm: stub().llm });
    await qualify(D, { ...o, llm: stub().llm });
    const out = approve(D, { trainer: 'Pat Trainer' }, { ...o, gitCommit: true });
    assert.match(out.gitCommit, /^[0-9a-f]{40}$/);
    const files = git('show', '--name-only', '--format=%s', 'HEAD').split('\n');
    assert.equal(files[0], `release: ${D} approved by Pat Trainer`);
    assert.ok(files.includes(`templates/${D}.json`) && files.includes('registry/index.json') && files.includes(`release/${D}/manifest.json`));
    assert.ok(!files.some((f) => f.startsWith('drafts/') || f.startsWith('data/')), 'drafts and data are not committed');
  });
});

test('CLI: drafts, approve usage and errors are plain English', () => {
  const run = (...a) => { try { return { out: execFileSync('node', ['factory.mjs', ...a], { cwd: REPO, stdio: 'pipe' }).toString(), code: 0 }; } catch (e) { return { out: e.stderr.toString(), code: e.status }; } };
  assert.equal(run('drafts').code, 0);
  const noTrainer = run('approve', 'safi.cs-graduate-jobseeker@1.0.1');
  assert.equal(noTrainer.code, 1);
  assert.match(noTrainer.out, /^Error: /);
  assert.doesNotMatch(noTrainer.out, /\.mjs:\d+/);
  assert.equal(run('qualify').code, 1);
  assert.equal(run('train', 'safi.cs-graduate-jobseeker@1.0.0').code, 1);
});

test('the real repo still has only T2@1.0.0 (tests never publish into it)', () => {
  assert.equal(loadRegistry({ root: REPO }).filter((e) => e.kind === 'template' && e.id === 'safi.cs-graduate-jobseeker').length, 1);
  assert.equal(existsSync(path.join(REPO, 'templates', `${D}.json`)), false);
});
