import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { compile } from '../lib/compiler.mjs';
import { hashText } from '../lib/canonical.mjs';
import { instantiate, getInstance, listInstances, loadOfficeGrants, intersectTools, instanceDir } from '../lib/instance.mjs';
import { REPO, makeRoot, cleanup, profile, codeIs } from './helpers.mjs';

const T2 = 'safi.cs-graduate-jobseeker@1.0.0';

function withRoot(fn) {
  const root = makeRoot();
  try {
    return fn(root, { root });
  } finally {
    cleanup(root);
  }
}

test('the Alex Example fixture is synthetic, has zero paid employment and evidence ids everywhere', () => {
  const p = profile();
  assert.equal(p.candidateName, 'Alex Example');
  assert.deepEqual(p.paidEmployment, []);
  assert.ok(p.projects.some((x) => x.kind === 'capstone'));
  const ids = [...p.education, ...p.projects, ...p.skills].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of p.skills) for (const e of s.evidenceIds) assert.ok(ids.includes(e), `skill evidence ${e} exists`);
});

test('instantiate writes an immutable manifest pinning ancestry, skills, knowledge, model and runtime package', () =>
  withRoot((root, opts) => {
    const compiled = compile(T2, opts);
    const m = instantiate(T2, profile(), { ...opts, model: 'test-model-1' });
    assert.match(m.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(m.name, 'CS Job Search Coach');
    assert.equal(m.effectiveSha256, compiled.effectiveSha256);
    assert.deepEqual(m.ancestry, compiled.ancestry);
    assert.equal(m.templateRef.sha256, compiled.effective.templateRef.sha256);
    assert.equal(m.skills.length, 4);
    assert.equal(m.knowledge.length, 3);
    assert.ok(m.skills.every((s) => /^[0-9a-f]{64}$/.test(s.sha256)));
    assert.equal(m.model, 'test-model-1');
    assert.equal(m.runtimePackageSha256, hashText(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')));
    const dir = instanceDir(m.instanceId, opts);
    assert.ok(existsSync(path.join(dir, 'manifest.json')));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'profile.json'), 'utf8')), profile());
    assert.ok(existsSync(path.join(dir, 'runs')) && existsSync(path.join(dir, 'outputs')));
    assert.deepEqual(getInstance(m.instanceId, opts).manifest, m);
    // The manifest is marked read-only where the file system supports it.
    if (process.platform !== 'win32') assert.equal(statSync(path.join(dir, 'manifest.json')).mode & 0o222, 0);
  }));

test('two instances from the same template get distinct permanent ids and separate directories', () =>
  withRoot((root, opts) => {
    const a = instantiate(T2, profile(), opts);
    const b = instantiate(T2, profile(), { ...opts, name: 'Second coach' });
    assert.notEqual(a.instanceId, b.instanceId);
    assert.equal(a.effectiveSha256, b.effectiveSha256);
    assert.equal(b.name, 'Second coach');
    assert.equal(listInstances(opts).length, 2);
    assert.notEqual(instanceDir(a.instanceId, opts), instanceDir(b.instanceId, opts));
  }));

test('model comes from LLM_MODEL when set, otherwise the documented default', () =>
  withRoot((root, opts) => {
    const saved = process.env.LLM_MODEL;
    try {
      delete process.env.LLM_MODEL;
      assert.equal(instantiate(T2, profile(), opts).model, 'claude-sonnet-4-5');
      process.env.LLM_MODEL = 'some-other-model';
      assert.equal(instantiate(T2, profile(), opts).model, 'some-other-model');
    } finally {
      if (saved === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = saved;
    }
  }));

test('customer data is only written under the data directory, never into templates/knowledge', () =>
  withRoot((root, opts) => {
    const before = readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');
    const m = instantiate(T2, profile(), opts);
    assert.ok(instanceDir(m.instanceId, opts).startsWith(path.join(root, 'data')));
    assert.equal(readFileSync(path.join(root, 'registry', 'index.json'), 'utf8'), before);
    for (const d of ['templates', 'knowledge', 'skills', 'registry']) {
      for (const n of readdirSync(path.join(root, d))) {
        assert.ok(!/Alex Example/.test(readFileSync(path.join(root, d, n), 'utf8')), `${d}/${n}`);
      }
    }
  }));

// ---- effective tools = template tools ∩ Office grants ----
test('effective tools are the intersection of template tools and Office grants', () =>
  withRoot((root, opts) => {
    assert.deepEqual(instantiate(T2, profile(), opts).tools, ['knowledge_lookup', 'profile_read']);
    writeFileSync(path.join(root, 'config', 'office-grants.json'), JSON.stringify({ grants: ['knowledge_lookup'] }));
    assert.deepEqual(instantiate(T2, profile(), opts).tools, ['knowledge_lookup']);
    writeFileSync(path.join(root, 'config', 'office-grants.json'), JSON.stringify({ grants: [] }));
    assert.deepEqual(instantiate(T2, profile(), opts).tools, []);
  }));

test('Office grants naming a forbidden tool are rejected, and the intersection never contains one', () =>
  withRoot((root, opts) => {
    for (const bad of ['submit_application', 'send_email', 'scrape', 'use_credentials']) {
      writeFileSync(path.join(root, 'config', 'office-grants.json'), JSON.stringify({ grants: ['knowledge_lookup', bad] }));
      assert.throws(() => loadOfficeGrants(opts), codeIs('FORBIDDEN_TOOL'), bad);
      assert.throws(() => instantiate(T2, profile(), opts), codeIs('FORBIDDEN_TOOL'), bad);
    }
    assert.deepEqual(intersectTools(['knowledge_lookup', 'send_email'], ['knowledge_lookup', 'send_email']), ['knowledge_lookup']);
    assert.ok(!compile(T2).effective.tools.some((t) => ['submit_application', 'send_email', 'scrape', 'use_credentials'].includes(t)));
  }));

// ---- A04: invalid parameters ----
test('A04: a missing required field is rejected by Ajv with a plain message', () =>
  withRoot((root, opts) => {
    const p = profile();
    delete p.preferredRoles;
    assert.throws(() => instantiate(T2, p, opts), (e) => e.code === 'CONFIG_INVALID' && /preferredRoles/.test(e.message));
    assert.equal(listInstances(opts).length, 0, 'nothing is created on failure');
  }));

test('A04: an unknown field is rejected (sealed schema)', () =>
  withRoot((root, opts) => {
    const p = { ...profile(), secretBackdoor: true };
    assert.throws(() => instantiate(T2, p, opts), (e) => e.code === 'CONFIG_INVALID' && /secretBackdoor/.test(e.message));
  }));

test('A04: a wrong type or value is rejected', () =>
  withRoot((root, opts) => {
    assert.throws(() => instantiate(T2, { ...profile(), preferredRoles: ['astronaut'] }, opts), codeIs('CONFIG_INVALID'));
    assert.throws(() => instantiate(T2, { ...profile(), candidateName: 42 }, opts), codeIs('CONFIG_INVALID'));
    assert.throws(() => instantiate(T2, { ...profile(), consentToHostedModel: false }, opts), codeIs('CONFIG_INVALID'));
    const p = profile();
    p.projects[0].kind = 'job';
    assert.throws(() => instantiate(T2, p, opts), codeIs('CONFIG_INVALID'));
  }));

test('semantic: contact preference outside the allowed set is rejected', () =>
  withRoot((root, opts) => {
    assert.throws(
      () => instantiate(T2, { ...profile(), contactPreferences: ['email', 'carrier-pigeon'] }, opts),
      (e) => e.code === 'CONFIG_SEMANTIC' && /carrier-pigeon/.test(e.message)
    );
  }));

test('semantic: credential-looking strings anywhere in the profile are rejected', () =>
  withRoot((root, opts) => {
    for (const secret of ['my password: hunter2', 'api_key=abcd1234', 'sk-ant-abcdefghijklmnopqrstuvwx', 'AKIAABCDEFGHIJKLMNOP']) {
      const p = profile();
      p.projects[1].description = `Notes ${secret}`;
      assert.throws(() => instantiate(T2, p, opts), codeIs('CONFIG_SEMANTIC'), secret);
    }
    assert.equal(listInstances(opts).length, 0);
  }));

test('semantic: duplicate evidence ids are rejected', () =>
  withRoot((root, opts) => {
    const p = profile();
    p.skills[0].id = p.projects[0].id;
    assert.throws(() => instantiate(T2, p, opts), (e) => e.code === 'CONFIG_SEMANTIC' && /more than once/.test(e.message));
  }));

test('a bad template reference or unknown template fails before anything is written', () =>
  withRoot((root, opts) => {
    assert.throws(() => instantiate('nope', profile(), opts), codeIs('BAD_REF'));
    assert.throws(() => instantiate('safi.nothing@1.0.0', profile(), opts), codeIs('TEMPLATE_NOT_FOUND'));
    assert.equal(listInstances(opts).length, 0);
  }));

test('getInstance rejects malformed ids (no path traversal) and unknown ids', () =>
  withRoot((root, opts) => {
    assert.throws(() => getInstance('../../etc', opts), codeIs('BAD_INSTANCE_ID'));
    assert.throws(() => getInstance('123e4567-e89b-42d3-a456-426614174000', opts), codeIs('INSTANCE_NOT_FOUND'));
  }));
