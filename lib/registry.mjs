// Exact-release registry: registry/index.json = [{kind,id,version,path,sha256}] for
// templates, skills and knowledge. All reads verify content against the registry hash.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { FactoryError, digestOf, hashText } from './canonical.mjs';
import { REPO_ROOT, assertValid } from './validate.mjs';

export const rootOf = (opts = {}) => path.resolve(opts.root ?? REPO_ROOT);

export function readJson(file, what) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new FactoryError(`${what} could not be read at ${file}. Check that the file exists.`, 'FILE_MISSING');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new FactoryError(`${what} is not valid JSON (${e.message}). Fix the file and try again.`, 'JSON_INVALID');
  }
}

export function loadRegistry(opts = {}) {
  const file = path.join(rootOf(opts), 'registry', 'index.json');
  const entries = readJson(file, 'The release registry');
  if (!Array.isArray(entries)) throw new FactoryError('The release registry must be a list of entries.', 'REGISTRY_INVALID');
  return entries;
}

export function saveRegistry(entries, opts = {}) {
  const dir = path.join(rootOf(opts), 'registry');
  mkdirSync(dir, { recursive: true });
  const key = (e) => `${e.kind}/${e.id}/${e.version}`;
  const sorted = [...entries].sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(path.join(dir, 'index.json'), JSON.stringify(sorted, null, 2) + '\n');
}

export function findEntry(entries, kind, id, version) {
  return entries.find((e) => e.kind === kind && e.id === id && (version === undefined || e.version === version));
}

/** Append a new release entry. Same kind+id+version with a different hash is rejected. */
export function addEntry(entry, opts = {}) {
  const entries = loadRegistry(opts);
  const existing = findEntry(entries, entry.kind, entry.id, entry.version);
  if (existing) {
    if (existing.sha256 === entry.sha256) return entries;
    throw new FactoryError(
      `${entry.kind} ${entry.id}@${entry.version} is already released with different content. Released versions never change; publish a new version instead.`,
      'VERSION_CONFLICT'
    );
  }
  entries.push(entry);
  saveRegistry(entries, opts);
  return entries;
}

export function parseRef(ref) {
  const m = /^([a-z][a-z0-9]*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+)@(\d+\.\d+\.\d+)$/.exec(ref ?? '');
  if (!m) throw new FactoryError(`"${ref}" is not a template reference. Use the form id@version, for example safi.agent@1.0.0.`, 'BAD_REF');
  return { id: m[1], version: m[2] };
}

/**
 * Load a template by exact id+version. It must be in the registry, its stored digest must match its
 * content, and the registry sha must match. With opts.allowDraft a draft in drafts/ is accepted
 * (used by train/qualify): drafts are verified for self-digest only.
 */
export function loadTemplate(id, version, opts = {}) {
  const root = rootOf(opts);
  const entries = loadRegistry(opts);
  const entry = findEntry(entries, 'template', id, version);
  let file;
  let pinned = null;
  if (entry) {
    file = path.join(root, entry.path);
    pinned = entry.sha256;
  } else if (opts.allowDraft && existsSync(path.join(root, 'drafts', `${id}@${version}.json`))) {
    file = path.join(root, 'drafts', `${id}@${version}.json`);
  } else {
    throw new FactoryError(`Template ${id}@${version} is not in the release registry. Check the id and version.`, 'TEMPLATE_NOT_FOUND');
  }
  const template = readJson(file, `Template ${id}@${version}`);
  assertValid('template.meta.schema.json', template, `Template ${id}@${version}`, 'TEMPLATE_INVALID');
  if (template.id !== id || template.version !== version) {
    throw new FactoryError(`Template file for ${id}@${version} actually declares ${template.id}@${template.version}.`, 'TEMPLATE_MISMATCH');
  }
  const actual = digestOf(template);
  if (template.digest !== actual) {
    throw new FactoryError(
      `Template ${id}@${version} has been changed since it was released (its digest no longer matches its content). Released versions are immutable; restore the original or publish a new version.`,
      'DIGEST_MISMATCH'
    );
  }
  if (pinned !== null && pinned !== actual) {
    throw new FactoryError(
      `Template ${id}@${version} does not match the hash recorded in the release registry. Released versions are immutable; restore the original or publish a new version.`,
      'REGISTRY_HASH_MISMATCH'
    );
  }
  return { template, sha256: actual };
}

export function loadSkill(id, version, opts = {}) {
  const root = rootOf(opts);
  const entry = findEntry(loadRegistry(opts), 'skill', id, version);
  if (!entry) throw new FactoryError(`Skill ${id}@${version} is not in the release registry.`, 'SKILL_NOT_FOUND');
  const skill = readJson(path.join(root, entry.path), `Skill ${id}@${version}`);
  assertValid('skill.meta.schema.json', skill, `Skill ${id}@${version}`, 'SKILL_INVALID');
  const actual = digestOf(skill);
  if (skill.digest !== actual || entry.sha256 !== actual) {
    throw new FactoryError(`Skill ${id}@${version} has changed since release (hash mismatch). Restore the original or publish a new version.`, 'DIGEST_MISMATCH');
  }
  return { skill, sha256: actual };
}

/** Knowledge docs: markdown with a front-matter block of "key: value" lines between --- fences. */
export function parseKnowledge(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!m) throw new FactoryError('A knowledge document must start with a front-matter block between "---" lines.', 'KNOWLEDGE_INVALID');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new FactoryError(`Knowledge front matter line "${line}" is not "key: value".`, 'KNOWLEDGE_INVALID');
    meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

export function loadKnowledge(id, opts = {}) {
  const root = rootOf(opts);
  const entry = findEntry(loadRegistry(opts), 'knowledge', id);
  if (!entry) throw new FactoryError(`Knowledge document "${id}" is not in the release registry.`, 'KNOWLEDGE_NOT_FOUND');
  const text = readFileSync(path.join(root, entry.path), 'utf8');
  const { meta, body } = parseKnowledge(text);
  assertValid('knowledge.meta.schema.json', meta, `Knowledge document ${id}`, 'KNOWLEDGE_INVALID');
  const actual = hashText(text);
  if (actual !== entry.sha256) {
    throw new FactoryError(`Knowledge document "${id}" has changed since release (hash mismatch). Restore the original.`, 'DIGEST_MISMATCH');
  }
  if (meta.id !== id || meta.version !== entry.version) {
    throw new FactoryError(`Knowledge document "${id}" front matter does not match its registry entry.`, 'KNOWLEDGE_INVALID');
  }
  return { meta, body, sha256: actual };
}

/** Re-verify every registry entry hash. Returns [{kind,id,version,ok,error?}]. */
export function verifyRegistry(opts = {}) {
  return loadRegistry(opts).map((e) => {
    const base = { kind: e.kind, id: e.id, version: e.version };
    try {
      if (e.kind === 'template') loadTemplate(e.id, e.version, opts);
      else if (e.kind === 'skill') loadSkill(e.id, e.version, opts);
      else if (e.kind === 'knowledge') loadKnowledge(e.id, opts);
      else throw new FactoryError(`Unknown registry kind "${e.kind}".`, 'REGISTRY_INVALID');
      return { ...base, ok: true };
    } catch (err) {
      return { ...base, ok: false, error: err.message };
    }
  });
}
