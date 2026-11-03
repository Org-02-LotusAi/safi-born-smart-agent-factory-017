// Live A07/A08: one full Train -> Qualify -> Approve/Publish flow against the real model, in a TEMP copy of
// the repo root (the real repo stays at T2@1.0.0). Spends a few cents. Run: npm run test:live
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { compile } from '../../lib/compiler.mjs';
import { instantiate, getInstance } from '../../lib/instance.mjs';
import { loadRegistry, verifyRegistry } from '../../lib/registry.mjs';
import { train } from '../../lib/training.mjs';
import { qualify } from '../../lib/qualify.mjs';
import { approve } from '../../lib/publish.mjs';
import { digestOf } from '../../lib/canonical.mjs';
import { makeRoot, cleanup, profile, codeIs, REPO } from '../helpers.mjs';

const T2 = 'safi.cs-graduate-jobseeker@1.0.0';
const D = 'safi.cs-graduate-jobseeker@1.0.1';
const LESSON = 'A capstone or class project is not paid employment; never list it as paid work or count it as years of experience';
const skip = process.env.ANTHROPIC_API_KEY ? false : 'ANTHROPIC_API_KEY is not set: add it to .env and run "npm run test:live" to exercise the real model.';

let root, o, before100, instBefore, trained, qual, pub, v100Bytes;
const bytes = (rel) => readFileSync(path.join(root, rel));

before(async () => {
  if (skip) return;
  root = makeRoot();
  o = { root };
  v100Bytes = bytes(`templates/${T2}.json`);
  instBefore = instantiate(T2, profile(), o);
  before100 = JSON.parse(readFileSync(path.join(root, 'data', 'instances', instBefore.instanceId, 'manifest.json'), 'utf8'));
  trained = await train(T2, LESSON, o);
  console.log(`# live: train ok draft=${trained.draftRef} request=${trained.proposal.requestId} model=${trained.proposal.model}`);
  console.log(`# live: proposal tests = ${trained.draft.refinement.addTests.map((t) => `${t.id}(${t.kind})`).join(', ')}`);
  console.log(`# live: proposal = ${JSON.stringify(trained.draft.refinement)}`);
  qual = await qualify(D, o);
  for (const r of qual.results) console.log(`# live: ${r.status} ${r.testId} [${r.kind}] origin=${r.origin} request=${r.evidence.requestId ?? '-'}${r.status === 'PASS' ? '' : ' reasons=' + JSON.stringify(r.evidence.reasons)}`);
});
after(() => root && cleanup(root));

test('A07 train: real model proposes a typed refinement with a behavioral regression test; draft 1.0.1 pins 1.0.0 by sha', { skip }, () => {
  assert.equal(trained.status, 'DRAFT');
  assert.equal(trained.draftRef, D);
  const t2 = loadRegistry({ root }).find((e) => e.id === 'safi.cs-graduate-jobseeker');
  assert.equal(trained.draft.parent.sha256, t2.sha256);
  assert.ok(trained.draft.refinement.addConstraints.length >= 1);
  assert.ok(trained.draft.refinement.addTests.some((t) => t.kind === 'behavioral'));
  assert.ok(trained.proposal.requestId, 'proposal request id recorded');
  assert.equal(existsSync(path.join(root, 'templates', `${D}.json`)), false, 'not published by training');
});

test('A07 qualify: ALL tests (inherited + new) ran on the live model and PASS with evidence', { skip }, () => {
  const eff = compile(D, { ...o, allowDraft: true }).effective;
  assert.equal(qual.results.length, eff.tests.length);
  assert.deepEqual(qual.results.filter((r) => r.status !== 'PASS').map((r) => [r.testId, r.evidence.reasons]), []);
  assert.equal(qual.allPass, true);
  const origins = new Set(qual.results.map((r) => r.origin));
  assert.ok(origins.has('safi.agent@1.0.0') && origins.has(T2) && origins.has(D), 'inherited and new tests all ran');
  for (const r of qual.results.filter((x) => x.kind === 'behavioral')) {
    assert.ok(r.evidence.requestId && r.evidence.runId && r.evidence.excerpt, `${r.testId} has evidence`);
    assert.match(r.evidence.model, /^claude-/);
  }
});

test('A07 approve negative: a draft changed after qualification is refused', { skip }, () => {
  const file = path.join(root, 'drafts', `${D}.json`);
  const original = readFileSync(file);
  const d = JSON.parse(original.toString());
  d.refinement.addRoleGuidance = [...(d.refinement.addRoleGuidance ?? []), 'Changed after qualification.'];
  d.digest = digestOf(d);
  writeFileSync(file, JSON.stringify(d, null, 2) + String.fromCharCode(10));
  try {
    assert.throws(() => approve(D, { trainer: 'Live Trainer' }, o), codeIs('STALE_QUALIFICATION'));
  } finally {
    writeFileSync(file, original); // restore the exact original bytes
  }
});

test('A08 approve + publish: 1.0.1 released; old agent pinned to 1.0.0 with unchanged hash; new agent has the constraint; 1.0.0 bytes unchanged', { skip }, () => {
  pub = approve(D, { trainer: 'Live Trainer' }, o);
  assert.equal(pub.trainer, 'Live Trainer');
  assert.ok(verifyRegistry({ root }).every((r) => r.ok));
  assert.ok(existsSync(path.join(root, 'release', D, 'manifest.json')) && existsSync(path.join(root, 'release', D, 'SHA256SUMS')));
  assert.deepEqual(bytes(`templates/${T2}.json`), v100Bytes, 'v1.0.0 file bytes unchanged');
  const old = getInstance(instBefore.instanceId, { root }).manifest;
  assert.deepEqual(old, before100, 'existing agent manifest untouched');
  assert.equal(old.templateRef.version, '1.0.0');
  assert.equal(compile(T2, { root }).effectiveSha256, instBefore.effectiveSha256, 'compiled hash of 1.0.0 unchanged');
  const fresh = instantiate(D, profile(), o);
  assert.equal(fresh.templateRef.version, '1.0.1');
  const eff = compile(D, { root }).effective;
  for (const c of trained.draft.refinement.addConstraints) assert.ok(eff.constraints.some((x) => x.id === c.id && x.text === c.text), `new constraint ${c.id} is in the effective definition`);
  assert.ok(!compile(T2, { root }).effective.constraints.some((x) => x.id === trained.draft.refinement.addConstraints[0].id));
});

test('the real repo is still at T2@1.0.0 only', { skip }, () => {
  assert.equal(loadRegistry({ root: REPO }).filter((e) => e.id === 'safi.cs-graduate-jobseeker').length, 1);
  assert.equal(existsSync(path.join(REPO, 'drafts', `${D}.json`)), false);
});
