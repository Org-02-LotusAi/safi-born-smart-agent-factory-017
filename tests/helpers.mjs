// Test helpers: each test works on a temporary copy of the repo content so the real registry,
// templates and data/ directory are never mutated.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestOf } from '../lib/canonical.mjs';
import { loadRegistry, saveRegistry } from '../lib/registry.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'safi-factory-'));
  for (const d of ['templates', 'skills', 'knowledge', 'registry', 'config']) {
    cpSync(path.join(REPO, d), path.join(root, d), { recursive: true });
  }
  cpSync(path.join(REPO, 'package-lock.json'), path.join(root, 'package-lock.json'));
  return root;
}

export const cleanup = (root) => rmSync(root, { recursive: true, force: true });

export const readFixture = (name) => JSON.parse(readFileSync(path.join(REPO, 'fixtures', name), 'utf8'));
export const profile = () => readFixture('alex-example.profile.json');

/**
 * Write a template into a temp root and register it. Missing parent.sha256 is filled from the
 * registry; `register:false` leaves it out of the registry. Digest is computed unless `digest` is given.
 */
export function addTemplate(root, template, { register = true, fillParent = true } = {}) {
  const t = structuredClone(template);
  const reg = loadRegistry({ root });
  if (fillParent && t.parent && !t.parent.sha256) {
    const p = reg.find((e) => e.kind === 'template' && e.id === t.parent.id && e.version === t.parent.version);
    t.parent.sha256 = p ? p.sha256 : '0'.repeat(64);
  }
  if (!t.digest) t.digest = digestOf(t);
  const rel = `templates/${t.id}@${t.version}.json`;
  writeFileSync(path.join(root, rel), JSON.stringify(t, null, 2) + '\n');
  if (register) {
    reg.push({ kind: 'template', id: t.id, version: t.version, path: rel, sha256: digestOf(t) });
    saveRegistry(reg, { root });
  }
  return t;
}

export const readTemplateFile = (root, id, version) =>
  JSON.parse(readFileSync(path.join(root, 'templates', `${id}@${version}.json`), 'utf8'));

export function writeTemplateFile(root, t) {
  writeFileSync(path.join(root, 'templates', `${t.id}@${t.version}.json`), JSON.stringify(t, null, 2) + '\n');
}

/** Assert that fn throws a FactoryError with the given code. */
export function codeIs(code) {
  return (e) => {
    if (e?.code !== code) throw new Error(`expected error code ${code}, got ${e?.code}: ${e?.message}`);
    return true;
  };
}
