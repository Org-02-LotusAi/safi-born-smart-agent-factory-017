// DEV-ONLY. Recomputes skill digests, knowledge hashes, template parent/ref pins and digests, and
// rewrites registry/index.json and knowledge/index.json. Use it while authoring source files.
// Never run it to "fix" an already-released template: released content is immutable.
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { digestOf, hashText } from '../lib/canonical.mjs';
import { parseKnowledge, saveRegistry } from '../lib/registry.mjs';
import { REPO_ROOT } from '../lib/validate.mjs';

const root = process.env.REHASH_ROOT ? path.resolve(process.env.REHASH_ROOT) : REPO_ROOT;
const readJ = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJ = (f, o) => writeFileSync(f, JSON.stringify(o, null, 2) + '\n');
const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const entries = [];

// Guard: anything already in registry/index.json is released and immutable. If its file no longer matches the pinned
// SHA-256, someone edited a released file, and re-digesting would quietly bless the edit. Refuse unless --force-dev.
const FORCE = process.argv.includes('--force-dev');
{
  const regFile = path.join(root, 'registry', 'index.json');
  const registered = existsSync(regFile) ? readJ(regFile) : [];
  const changed = [];
  for (const e of registered) {
    const file = path.join(root, e.path);
    if (!existsSync(file)) { changed.push(`${e.kind} ${e.id}@${e.version} (file missing: ${e.path})`); continue; }
    const now = e.kind === 'knowledge' ? hashText(readFileSync(file, 'utf8')) : digestOf(readJ(file));
    if (now !== e.sha256) changed.push(`${e.kind} ${e.id}@${e.version} (${e.path})`);
  }
  if (changed.length && !FORCE) {
    const list = changed.map((c) => `  ${c}`).join('\n');
    console.error(`Refusing to rehash: these released files differ from the SHA-256 pinned in registry/index.json:\n${list}\nReleased content is immutable. Restore the files from git (git checkout -- <path>) or publish a new version.\nDev-only override for a scratch copy: node scripts/rehash.mjs --force-dev`);
    process.exit(1);
  }
  if (changed.length) {
    console.warn('\n!!! --force-dev: RE-DIGESTING RELEASED FILES. This breaks the immutability promise for existing agents and releases. Use only in a throwaway copy. !!!\n');
  }
}

// Skills
const skillSha = new Map();
for (const f of readdirSync(path.join(root, 'skills')).filter((n) => n.endsWith('.json')).sort()) {
  const file = path.join(root, 'skills', f);
  const s = readJ(file);
  s.digest = digestOf(s);
  writeJ(file, s);
  skillSha.set(`${s.id}@${s.version}`, s.digest);
  entries.push({ kind: 'skill', id: s.id, version: s.version, path: rel(file), sha256: s.digest });
}

// Knowledge
const knowSha = new Map();
const knowIndex = [];
for (const f of readdirSync(path.join(root, 'knowledge')).filter((n) => n.endsWith('.md')).sort()) {
  const file = path.join(root, 'knowledge', f);
  const text = readFileSync(file, 'utf8');
  const { meta } = parseKnowledge(text);
  const sha = hashText(text);
  knowSha.set(meta.id, sha);
  knowIndex.push({ id: meta.id, version: meta.version, title: meta.title, author: meta.author, date: meta.date, source: meta.source, file: rel(file), sha256: sha });
  entries.push({ kind: 'knowledge', id: meta.id, version: meta.version, path: rel(file), sha256: sha });
}
writeJ(path.join(root, 'knowledge', 'index.json'), knowIndex);

// Templates: parents first
const tFiles = readdirSync(path.join(root, 'templates')).filter((n) => n.endsWith('.json')).sort();
const templates = new Map(tFiles.map((f) => [f, readJ(path.join(root, 'templates', f))]));
const done = new Map();
const pending = new Set(tFiles);
while (pending.size) {
  const before = pending.size;
  for (const f of [...pending]) {
    const t = templates.get(f);
    if (t.parent) {
      const p = done.get(`${t.parent.id}@${t.parent.version}`);
      if (!p) continue;
      t.parent.sha256 = p;
    }
    for (const r of [...(t.refinement.addSkillRefs ?? []), ...t.skillRefs]) {
      const s = skillSha.get(`${r.id}@${r.version}`);
      if (!s) throw new Error(`Template ${f} references unknown skill ${r.id}@${r.version}`);
      r.sha256 = s;
    }
    for (const r of [...(t.refinement.addKnowledgeRefs ?? []), ...t.knowledgeRefs]) {
      const k = knowSha.get(r.id);
      if (!k) throw new Error(`Template ${f} references unknown knowledge ${r.id}`);
      r.sha256 = k;
    }
    t.digest = digestOf(t);
    writeJ(path.join(root, 'templates', f), t);
    done.set(`${t.id}@${t.version}`, t.digest);
    entries.push({ kind: 'template', id: t.id, version: t.version, path: `templates/${f}`, sha256: t.digest });
    pending.delete(f);
  }
  if (pending.size === before) throw new Error(`Cannot resolve parents for: ${[...pending].join(', ')}`);
}

saveRegistry(entries, { root });
console.log(`Rehashed ${entries.length} registry entries in ${root}`);
for (const e of entries) console.log(`  ${e.kind.padEnd(9)} ${e.id}@${e.version}  ${e.sha256}`);
