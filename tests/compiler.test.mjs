import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compile, checkInvariants, runStructuralTests } from '../lib/compiler.mjs';
import { digestOf, hashObject, canonicalJson } from '../lib/canonical.mjs';
import { loadRegistry, saveRegistry, verifyRegistry } from '../lib/registry.mjs';
import { REPO, makeRoot, cleanup, addTemplate, readFixture, readTemplateFile, writeTemplateFile, codeIs } from './helpers.mjs';

const T0 = 'safi.agent@1.0.0';
const T1 = 'safi.career@1.0.0';
const T2 = 'safi.cs-graduate-jobseeker@1.0.0';
const neg = (name) => readFixture(`negative/${name}.json`);

// ---------- canonical hashing ----------
test('RFC 8785: canonical form sorts keys and is independent of insertion order', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }));
});

test('digest excludes the digest field itself', () => {
  assert.equal(digestOf({ x: 1, digest: 'a' }), digestOf({ x: 1, digest: 'b' }));
  assert.equal(digestOf({ x: 1, digest: 'a' }), hashObject({ x: 1 }));
});

// ---------- registry / released content ----------
test('every registry entry verifies', () => {
  const results = verifyRegistry({ root: REPO });
  assert.equal(results.length, 10);
  assert.deepEqual(results.filter((r) => !r.ok), []);
});

// ---------- the shipped lineage ----------
test('T0 -> T1 -> T2 compile with pinned ancestry', () => {
  const t2 = compile(T2);
  assert.deepEqual(t2.ancestry.map((a) => `${a.id}@${a.version}`), [T0, T1, T2]);
  assert.match(t2.effectiveSha256, /^[0-9a-f]{64}$/);
  const t1 = compile(T1);
  assert.deepEqual(t1.ancestry.map((a) => `${a.id}@${a.version}`), [T0, T1]);
  assert.equal(t2.ancestry[1].sha256, t1.effective.templateRef.sha256);
});

test('T2 inherits every T0 and T1 constraint and test, with origins', () => {
  const t0 = compile(T0).effective;
  const t1 = compile(T1).effective;
  const t2 = compile(T2).effective;
  for (const parent of [t0, t1]) {
    for (const c of parent.constraints) assert.ok(t2.constraints.some((x) => x.id === c.id && x.text === c.text), `constraint ${c.id}`);
    for (const x of parent.tests) assert.ok(t2.tests.some((y) => y.id === x.id), `test ${x.id}`);
  }
  assert.equal(t2.constraints.find((c) => c.id === 'no-outward-action').origin, T0);
  assert.equal(t2.constraints.find((c) => c.id === 'consent-before-processing').origin, T1);
  assert.equal(t2.constraints.find((c) => c.id === 'entry-level-scope').origin, T2);
});

test('T2 has four skills, three knowledge docs, read-only tools and a sealed parameter schema', () => {
  const e = compile(T2).effective;
  assert.deepEqual(e.skills.map((s) => s.id).sort(), ['interview-coach', 'job-posting-gap-analysis', 'resume-evidence-map', 'seven-day-plan']);
  assert.equal(e.knowledge.length, 3);
  assert.deepEqual(e.tools, ['knowledge_lookup', 'profile_read']);
  assert.equal(e.parameterSchema.additionalProperties, false);
  for (const f of ['candidateName', 'consentToHostedModel', 'preferredRoles', 'locationPreference', 'contactPreferences', 'education', 'projects', 'skills']) {
    assert.ok(e.parameterSchema.required.includes(f), `${f} required`);
    assert.ok(f in e.parameterSchema.properties, `${f} defined`);
  }
});

test('structural baseline tests all pass for T0, T1 and T2; behavioral tests are declared', () => {
  for (const ref of [T0, T1, T2]) {
    const { effective } = compile(ref);
    const results = runStructuralTests(effective);
    assert.ok(results.length > 0);
    assert.deepEqual(results.filter((r) => r.status !== 'PASS'), [], ref);
  }
  const t2 = compile(T2).effective;
  const behavioral = t2.tests.filter((t) => t.kind === 'behavioral').map((t) => t.id);
  for (const id of ['t0-refuses-outward-action', 't0-ignores-embedded-instructions', 't1-no-invented-employment', 't2-gap-table-cites-evidence']) {
    assert.ok(behavioral.includes(id), id);
  }
});

test('knowledge docs are SAFI-authored, dated, and substantial', () => {
  const index = JSON.parse(readFileSync(path.join(REPO, 'knowledge', 'index.json'), 'utf8'));
  assert.ok(index.length >= 3);
  for (const k of index) {
    assert.equal(k.author, 'SAFI');
    assert.equal(k.date, '2026-11-03');
    const words = readFileSync(path.join(REPO, k.file), 'utf8').split(/\s+/).length;
    assert.ok(words >= 400, `${k.id} has ${words} words`);
  }
});

// ---------- A02: determinism ----------
test('A02: two compiles in one process give an identical effective hash', () => {
  const a = compile(T2);
  const b = compile(T2);
  assert.equal(a.effectiveSha256, b.effectiveSha256);
  assert.equal(canonicalJson(a.effective), canonicalJson(b.effective));
});

test('A02: two separate processes give the same hash as this process', () => {
  const expected = compile(T2).effectiveSha256;
  const run = () => JSON.parse(execFileSync(process.execPath, ['factory.mjs', 'compile', T2, '--json'], { cwd: REPO, encoding: 'utf8' })).effectiveSha256;
  assert.equal(run(), expected);
  assert.equal(run(), expected);
});

test('A02: compile is independent of the working directory', () => {
  const expected = compile(T2).effectiveSha256;
  const out = execFileSync(process.execPath, [path.join(REPO, 'factory.mjs'), 'compile', T2, '--json'], { cwd: path.join(REPO, 'tests'), encoding: 'utf8' });
  assert.equal(JSON.parse(out).effectiveSha256, expected);
});

test('control: a valid additive child compiles, inherits everything and changes the hash', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-valid-addition'));
    const child = compile('good.child@1.0.0', { root });
    const t2 = compile(T2, { root });
    assert.notEqual(child.effectiveSha256, t2.effectiveSha256);
    assert.equal(child.effective.constraints.length, t2.effective.constraints.length + 1);
    assert.equal(child.effective.tests.length, t2.effective.tests.length);
  } finally {
    cleanup(root);
  }
});

// ---------- A03: lineage integrity ----------
test('A03 negative 1a: missing parent is rejected', () => {
  const root = makeRoot();
  try {
    const t = neg('child-valid-addition');
    t.id = 'orphan.child';
    t.parent = { id: 'safi.nothing', version: '9.9.9', sha256: 'a'.repeat(64) };
    addTemplate(root, t);
    assert.throws(() => compile('orphan.child@1.0.0', { root }), codeIs('MISSING_PARENT'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 1b: a parent pin with no sha256 is rejected by the meta-schema', () => {
  const root = makeRoot();
  try {
    const t = neg('child-valid-addition');
    t.parent = { id: 'safi.cs-graduate-jobseeker', version: '1.0.0' };
    addTemplate(root, t, { fillParent: false });
    assert.throws(() => compile('good.child@1.0.0', { root }), codeIs('TEMPLATE_INVALID'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 1c: mismatched parent sha256 is rejected', () => {
  const root = makeRoot();
  try {
    const t = neg('child-valid-addition');
    t.parent.sha256 = 'f'.repeat(64);
    addTemplate(root, t);
    assert.throws(() => compile('good.child@1.0.0', { root }), codeIs('PARENT_SHA_MISMATCH'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 2: a cycle in the ancestry is rejected', () => {
  const root = makeRoot();
  try {
    // A -> B -> A. B is written first with a placeholder pin; A pins B correctly.
    const base = neg('child-valid-addition');
    const b = { ...structuredClone(base), id: 'loop.b', parent: { id: 'loop.a', version: '1.0.0', sha256: 'b'.repeat(64) } };
    addTemplate(root, b);
    const bSha = digestOf(readTemplateFile(root, 'loop.b', '1.0.0'));
    const a = { ...structuredClone(base), id: 'loop.a', parent: { id: 'loop.b', version: '1.0.0', sha256: bSha } };
    addTemplate(root, a);
    assert.throws(() => compile('loop.a@1.0.0', { root }), codeIs('CYCLE'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 2b: a template that is its own parent is rejected', () => {
  const root = makeRoot();
  try {
    const t = neg('child-valid-addition');
    t.id = 'loop.self';
    t.parent = { id: 'loop.self', version: '1.0.0', sha256: 'c'.repeat(64) };
    addTemplate(root, t);
    assert.throws(() => compile('loop.self@1.0.0', { root }), codeIs('CYCLE'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 2c: duplicate template id in the chain is rejected', () => {
  const root = makeRoot();
  try {
    const t = neg('child-valid-addition');
    t.id = 'safi.career';
    t.version = '1.0.1';
    addTemplate(root, t); // parent T2 -> ... -> safi.career@1.0.0 again
    assert.throws(() => compile('safi.career@1.0.1', { root }), codeIs('DUPLICATE_ID'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 3a: changed same-version JSON (digest not updated) is rejected', () => {
  const root = makeRoot();
  try {
    const t1 = readTemplateFile(root, 'safi.career', '1.0.0');
    t1.description = t1.description + ' (quietly edited)';
    writeTemplateFile(root, t1);
    assert.throws(() => compile(T1, { root }), codeIs('DIGEST_MISMATCH'));
    assert.throws(() => compile(T2, { root }), codeIs('DIGEST_MISMATCH'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 3b: changed same-version JSON with a recomputed digest is rejected by the registry hash', () => {
  const root = makeRoot();
  try {
    const t1 = readTemplateFile(root, 'safi.career', '1.0.0');
    t1.description = t1.description + ' (quietly edited)';
    t1.digest = digestOf(t1);
    writeTemplateFile(root, t1);
    assert.throws(() => compile(T1, { root }), codeIs('REGISTRY_HASH_MISMATCH'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 3c: changed ancestor re-registered under the same version breaks the child pin', () => {
  const root = makeRoot();
  try {
    const t1 = readTemplateFile(root, 'safi.career', '1.0.0');
    t1.description = t1.description + ' (quietly edited)';
    t1.digest = digestOf(t1);
    writeTemplateFile(root, t1);
    const reg = loadRegistry({ root });
    reg.find((e) => e.id === 'safi.career').sha256 = t1.digest;
    saveRegistry(reg, { root });
    assert.throws(() => compile(T2, { root }), codeIs('PARENT_SHA_MISMATCH'));
  } finally {
    cleanup(root);
  }
});

test('A03 negative 3d: a changed skill or knowledge file is detected', () => {
  const root = makeRoot();
  try {
    const kfile = path.join(root, 'knowledge', 'cs-job-families-and-skills.md');
    writeFileSync(kfile, readFileSync(kfile, 'utf8') + '\nA sneaky extra line.\n');
    assert.throws(() => compile(T2, { root }), codeIs('DIGEST_MISMATCH'));
  } finally {
    cleanup(root);
  }
  const root2 = makeRoot();
  try {
    const sfile = path.join(root2, 'skills', 'seven-day-plan@1.0.0.json');
    const s = JSON.parse(readFileSync(sfile, 'utf8'));
    s.purpose += ' Extra.';
    writeFileSync(sfile, JSON.stringify(s, null, 2));
    assert.throws(() => compile(T2, { root: root2 }), codeIs('DIGEST_MISMATCH'));
  } finally {
    cleanup(root2);
  }
});

test('unknown template reference gives a clear error', () => {
  assert.throws(() => compile('safi.nothing@1.0.0'), codeIs('TEMPLATE_NOT_FOUND'));
  assert.throws(() => compile('not a ref'), codeIs('BAD_REF'));
});

// ---------- A04: inheritance invariants and typed refinements ----------
test('A04: an unknown "removeConstraints" operation is rejected (deleting an inherited rule is impossible)', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-remove-constraint'));
    assert.throws(
      () => compile('bad.remove-constraint@1.0.0', { root }),
      (e) => e.code === 'TEMPLATE_INVALID' && /removeConstraints/.test(e.message)
    );
  } finally {
    cleanup(root);
  }
});

test('A04: a child that carries its own tests list (could drop inherited tests) is rejected', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-owns-tests'));
    assert.throws(() => compile('bad.owns-tests@1.0.0', { root }), codeIs('TEMPLATE_INVALID'));
  } finally {
    cleanup(root);
  }
});

test('A04: a forged effective definition that drops a parent test fails the superset invariant', () => {
  const parent = compile(T1).effective;
  const forged = structuredClone(compile(T2).effective);
  forged.tests = forged.tests.filter((t) => t.id !== 't1-no-invented-employment');
  assert.throws(() => checkInvariants(parent, forged), codeIs('INVARIANT_TESTS'));
});

test('A04: a forged effective definition that drops or weakens a parent constraint fails the invariant', () => {
  const parent = compile(T1).effective;
  const dropped = structuredClone(compile(T2).effective);
  dropped.constraints = dropped.constraints.filter((c) => c.id !== 'no-outward-action');
  assert.throws(() => checkInvariants(parent, dropped), codeIs('INVARIANT_CONSTRAINTS'));
  const weakened = structuredClone(compile(T2).effective);
  weakened.constraints.find((c) => c.id === 'no-fabrication').text = 'Fabrication is fine.';
  assert.throws(() => checkInvariants(parent, weakened), codeIs('INVARIANT_CONSTRAINTS'));
});

test('A04: a forged effective definition that gains a tool fails (no privilege elevation)', () => {
  const parent = compile(T1).effective;
  const forged = structuredClone(compile(T2).effective);
  forged.tools.push('web_search');
  assert.throws(() => checkInvariants(parent, forged), codeIs('PRIVILEGE_ELEVATION'));
});

test('A04: re-defining an inherited constraint id (silent weakening) is a collision', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-constraint-collision'));
    assert.throws(() => compile('bad.constraint-collision@1.0.0', { root }), codeIs('COLLISION'));
  } finally {
    cleanup(root);
  }
});

test('field collision: redefining an inherited parameter field fails', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-field-collision'));
    assert.throws(() => compile('bad.field-collision@1.0.0', { root }), codeIs('COLLISION'));
  } finally {
    cleanup(root);
  }
});

test('unknown policy id fails', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-unknown-policy'));
    assert.throws(() => compile('bad.unknown-policy@1.0.0', { root }), codeIs('UNKNOWN_POLICY'));
  } finally {
    cleanup(root);
  }
});

test('unknown property in a template fails the meta-schema', () => {
  const root = makeRoot();
  try {
    addTemplate(root, neg('child-unknown-property'));
    assert.throws(
      () => compile('bad.unknown-property@1.0.0', { root }),
      (e) => e.code === 'TEMPLATE_INVALID' && /grantTools/.test(e.message)
    );
  } finally {
    cleanup(root);
  }
});

test('A04: an unapproved tool requested by a template fails compile', () => {
  const root = makeRoot();
  try {
    const t0 = readTemplateFile(root, 'safi.agent', '1.0.0');
    t0.base.tools = ['knowledge_lookup', 'web_search'];
    t0.digest = digestOf(t0);
    writeTemplateFile(root, t0);
    const reg = loadRegistry({ root });
    reg.find((e) => e.id === 'safi.agent').sha256 = t0.digest;
    saveRegistry(reg, { root });
    assert.throws(() => compile(T0, { root }), codeIs('UNAPPROVED_TOOL'));
  } finally {
    cleanup(root);
  }
});

test('A04: a forbidden tool (send_email) requested by a template fails compile', () => {
  const root = makeRoot();
  try {
    const t0 = readTemplateFile(root, 'safi.agent', '1.0.0');
    t0.base.tools = ['send_email'];
    t0.digest = digestOf(t0);
    writeTemplateFile(root, t0);
    const reg = loadRegistry({ root });
    reg.find((e) => e.id === 'safi.agent').sha256 = t0.digest;
    saveRegistry(reg, { root });
    assert.throws(() => compile(T0, { root }), codeIs('FORBIDDEN_TOOL'));
  } finally {
    cleanup(root);
  }
});

test('the registry refuses a second, different release of the same version', async () => {
  const { addEntry } = await import('../lib/registry.mjs');
  const root = makeRoot();
  try {
    const e = loadRegistry({ root }).find((x) => x.id === 'safi.agent');
    assert.doesNotThrow(() => addEntry({ ...e }, { root }));
    assert.throws(() => addEntry({ ...e, sha256: 'd'.repeat(64) }, { root }), codeIs('VERSION_CONFLICT'));
  } finally {
    cleanup(root);
  }
});
