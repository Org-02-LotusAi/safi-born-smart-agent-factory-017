// Read-only helpers for the HTTP layer and the SPA: template tree, template view with the origin of every
// inherited item, and the one-click demo fixtures. Nothing here writes anything or creates anything.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FactoryError } from './canonical.mjs';
import { compile } from './compiler.mjs';
import { fixturesDir } from './runtime.mjs';
import { loadRegistry, loadTemplate, parseRef, rootOf } from './registry.mjs';
import { draftsDir } from './training.mjs';
import { instanceDir } from './instance.mjs';

const refOf = (id, version) => `${id}@${version}`;

/**
 * listTemplateTree(opts) -> [{ ref, id, version, title, parentRef|null, status:"RELEASED"|"DRAFT", sha256 }]
 * Released templates come from the registry; drafts (opts.includeDrafts) from drafts/. Parent links let the UI draw the tree.
 */
export function listTemplateTree(opts = {}) {
  const nodes = [];
  for (const e of loadRegistry(opts).filter((x) => x.kind === 'template')) {
    const { template, sha256 } = loadTemplate(e.id, e.version, opts);
    nodes.push({ ref: refOf(e.id, e.version), id: e.id, version: e.version, title: template.title, description: template.description, parentRef: template.parent ? refOf(template.parent.id, template.parent.version) : null, status: 'RELEASED', sha256 });
  }
  if (opts.includeDrafts) {
    const dir = draftsDir(opts);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /@\d+\.\d+\.\d+\.json$/.test(f) && !/\.(meta|qualification|approval)\.json$/.test(f)) : [];
    for (const f of files) {
      const ref = f.replace(/\.json$/, '');
      if (nodes.some((n) => n.ref === ref)) continue; // already released
      const { id, version } = parseRef(ref);
      const { template, sha256 } = loadTemplate(id, version, { ...opts, allowDraft: true });
      nodes.push({ ref, id, version, title: template.title, description: template.description, parentRef: template.parent ? refOf(template.parent.id, template.parent.version) : null, status: 'DRAFT', sha256 });
    }
  }
  return nodes.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/**
 * templateView(ref, opts) -> { ref, status, raw, sha256, effective, effectiveSha256, ancestry, contract }
 * contract = the plain-English view: every constraint/test/guidance/knowledge/skill with its `origin` (the template that
 * introduced it) and `inherited` (true when it came from an ancestor rather than from this template).
 * opts.allowDraft lets a trainer open a draft.
 */
export function templateView(ref, opts = {}) {
  const { id, version } = parseRef(ref);
  const { template, sha256 } = loadTemplate(id, version, opts);
  const released = loadRegistry(opts).some((e) => e.kind === 'template' && e.id === id && e.version === version);
  const { effective, effectiveSha256, ancestry } = compile(ref, opts);
  const self = refOf(id, version);
  const mark = (list) => list.map((x) => ({ ...x, inherited: x.origin !== self }));
  return {
    ref: self,
    status: released ? 'RELEASED' : 'DRAFT',
    raw: template,
    sha256,
    effective,
    effectiveSha256,
    ancestry,
    contract: {
      constraints: mark(effective.constraints),
      tests: mark(effective.tests),
      roleGuidance: mark(effective.roleGuidance),
      knowledge: mark(effective.knowledge),
      skills: mark(effective.skills),
      tools: effective.tools,
      policies: effective.policies
    }
  };
}

/** demoFixture(opts) -> the Alex Example profile, resume and sample job for the one-click demo (synthetic data, safe to show). */
export function demoFixture(opts = {}) {
  const dir = fixturesDir(opts);
  const read = (f) => {
    const file = path.join(dir, f);
    if (!existsSync(file)) throw new FactoryError(`The demo file ${f} is missing from the fixtures folder.`, 'FIXTURE_MISSING');
    return readFileSync(file, 'utf8');
  };
  const meta = JSON.parse(read('job-swe-entry.meta.json'));
  return {
    profile: JSON.parse(read('alex-example.profile.json')),
    resumeText: read('alex-example.resume.txt'),
    job: { text: read('job-swe-entry.txt'), url: meta.url, accessDate: meta.accessDate },
    templateRef: 'safi.cs-graduate-jobseeker@1.0.0',
    note: 'Alex Example is a made-up person. Nothing here is real.'
  };
}

/** Names of job-posting fixtures a demo run may use (plain file names; no paths). */
export function listJobFixtures(opts = {}) {
  const dir = fixturesDir(opts);
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^job-[a-z0-9-]+\.txt$|^adversarial-job\.txt$/.test(f)).sort() : [];
}

export { rootOf };

/** runApproval(instanceId, runId, opts) -> the candidate's approval record for a run, or null when not approved yet. */
export function runApproval(instanceId, runId, opts = {}) {
  const dir = instanceDir(instanceId, opts);
  if (!/^[0-9a-f-]{36}$/.test(String(runId))) throw new FactoryError('That is not a valid run id.', 'BAD_RUN_ID');
  const file = path.join(dir, 'outputs', `${runId}.approval.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
