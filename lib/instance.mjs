// instantiate(templateRef, config): validate input, intersect tools with Office grants, mint a UUID,
// write an immutable manifest plus the private customer profile under data/instances/<uuid>/.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { FactoryError, hashText } from './canonical.mjs';
import { compile } from './compiler.mjs';
import { readJson, rootOf } from './registry.mjs';
import { newAjv, assertValid, formatAjvErrors } from './validate.mjs';
import { CONTACT_CHANNELS, CREDENTIAL_PATTERNS, FORBIDDEN_TOOLS, KNOWN_TOOLS } from './policies.mjs';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function dataDirOf(opts = {}) {
  return path.resolve(opts.dataDir ?? path.join(rootOf(opts), 'data'));
}

export function instanceDir(instanceId, opts = {}) {
  if (!/^[0-9a-f-]{36}$/.test(String(instanceId))) {
    throw new FactoryError('That is not a valid agent id. Agent ids look like 123e4567-e89b-42d3-a456-426614174000.', 'BAD_INSTANCE_ID');
  }
  return path.join(dataDirOf(opts), 'instances', instanceId);
}

/** Office grants: the customer-controlled tool list. Training can never change this file. */
export function loadOfficeGrants(opts = {}) {
  const grants = readJson(path.join(rootOf(opts), 'config', 'office-grants.json'), 'The Office tool grants file');
  if (!Array.isArray(grants.grants) || grants.grants.some((g) => typeof g !== 'string')) {
    throw new FactoryError('The Office tool grants file must contain a "grants" list of tool names.', 'GRANTS_INVALID');
  }
  for (const g of grants.grants) {
    if (FORBIDDEN_TOOLS.includes(g)) {
      throw new FactoryError(`The Office grants list the forbidden tool "${g}". Tools that act outward can never be granted. Remove it from config/office-grants.json.`, 'FORBIDDEN_TOOL');
    }
    if (!KNOWN_TOOLS.includes(g)) {
      throw new FactoryError(`The Office grants list "${g}", which is not a known tool.`, 'GRANTS_INVALID');
    }
  }
  return grants.grants;
}

/** Effective tools = template-requested tools intersected with Office grants. */
export function intersectTools(requested, granted) {
  return requested.filter((t) => granted.includes(t) && !FORBIDDEN_TOOLS.includes(t)).sort();
}

function walkStrings(value, visit, where = 'config') {
  if (typeof value === 'string') visit(value, where);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, visit, `${where}.${k}`);
}

/** Semantic checks, separate from structural JSON Schema validation. */
export function semanticChecks(config) {
  const problems = [];
  walkStrings(config, (s, where) => {
    if (CREDENTIAL_PATTERNS.some((re) => re.test(s))) {
      problems.push(`${where} looks like a password, key or token. Remove it; agents never receive credentials.`);
    }
  });
  if (Array.isArray(config.contactPreferences)) {
    for (const c of config.contactPreferences) {
      if (!CONTACT_CHANNELS.includes(c)) problems.push(`Contact preference "${c}" is not allowed. Choose from: ${CONTACT_CHANNELS.join(', ')}.`);
    }
  }
  if ('consentToHostedModel' in config && config.consentToHostedModel !== true) {
    problems.push('The candidate must consent to the profile being sent to the hosted AI model before an agent can be created.');
  }
  const seen = new Set();
  for (const key of ['education', 'projects', 'skills', 'paidEmployment']) {
    for (const item of Array.isArray(config[key]) ? config[key] : []) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        if (seen.has(item.id)) problems.push(`Evidence id "${item.id}" is used more than once. Every item needs its own id.`);
        seen.add(item.id);
      }
    }
  }
  return problems;
}

export function validateConfig(effective, config) {
  const validate = newAjv().compile(effective.parameterSchema);
  if (!validate(config)) {
    throw new FactoryError(`The agent settings are not valid: ${formatAjvErrors(validate.errors)}. Fix these fields and try again.`, 'CONFIG_INVALID', validate.errors);
  }
  const problems = semanticChecks(config);
  if (problems.length) {
    throw new FactoryError(`The agent settings need attention: ${problems.join(' ')}`, 'CONFIG_SEMANTIC', problems);
  }
}

function runtimePackageSha(opts) {
  const file = path.join(rootOf(opts), 'package-lock.json');
  if (!existsSync(file)) throw new FactoryError('package-lock.json is missing, so the runtime package cannot be pinned. Run npm install.', 'LOCKFILE_MISSING');
  return hashText(readFileSync(file, 'utf8'));
}

export function instantiate(templateRef, config, opts = {}) {
  const { effective, effectiveSha256 } = compile(templateRef, opts);
  validateConfig(effective, config);
  const tools = intersectTools(effective.tools, loadOfficeGrants(opts));
  const instanceId = randomUUID();
  const manifest = {
    instanceId,
    name: (opts.name ?? effective.title).trim(),
    templateRef: effective.templateRef,
    ancestry: effective.ancestry,
    skills: effective.skills.map(({ id, version, sha256 }) => ({ id, version, sha256 })),
    knowledge: effective.knowledge.map(({ id, sha256 }) => ({ id, sha256 })),
    effectiveSha256,
    runtimePackageSha256: runtimePackageSha(opts),
    model: opts.model ?? process.env.LLM_MODEL ?? DEFAULT_MODEL,
    tools,
    createdAt: new Date().toISOString()
  };
  assertValid('instance-manifest.schema.json', manifest, 'The agent manifest', 'MANIFEST_INVALID');
  const dir = instanceDir(instanceId, opts);
  mkdirSync(path.join(dir, 'runs'), { recursive: true });
  mkdirSync(path.join(dir, 'outputs'), { recursive: true });
  // 'wx' refuses to overwrite: a manifest is written exactly once and never rewritten.
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
  try {
    chmodSync(path.join(dir, 'manifest.json'), 0o444);
  } catch {
    // Read-only marking is best effort (not all file systems support it); 'wx' already prevents rewrites by the Factory.
  }
  return manifest;
}

export function getInstance(instanceId, opts = {}) {
  const dir = instanceDir(instanceId, opts);
  if (!existsSync(path.join(dir, 'manifest.json'))) {
    throw new FactoryError(`No agent with id ${instanceId} was found. Check the id or create a new agent.`, 'INSTANCE_NOT_FOUND');
  }
  const manifest = readJson(path.join(dir, 'manifest.json'), 'The agent manifest');
  assertValid('instance-manifest.schema.json', manifest, 'The agent manifest', 'MANIFEST_INVALID');
  const profile = readJson(path.join(dir, 'profile.json'), 'The agent profile');
  return { manifest, profile, dir };
}

export function listInstances(opts = {}) {
  const base = path.join(dataDirOf(opts), 'instances');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => getInstance(d.name, opts).manifest)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
