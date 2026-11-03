// Approve + publish: the explicit human step. A draft is released only if a qualification exists for the
// SAME draft bytes and every test passed. Older versions and existing agents are never touched.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { FactoryError, digestOf, sha256Hex } from './canonical.mjs';
import { compile } from './compiler.mjs';
import { addEntry, loadRegistry, findEntry, parseRef, rootOf } from './registry.mjs';
import { loadDraft, readQualification } from './qualify.mjs';
import { draftPath, qualificationPath, approvalPath } from './training.mjs';

const fileSha = (file) => sha256Hex(readFileSync(file));

/**
 * approve(draftRef, { trainer }, opts) -> { draftRef, trainer, at, templatePath, releaseDir, sha256, gitCommit? }
 * opts: { root, gitCommit, gitCommitSoft }
 *   gitCommit: commit exactly the new template, registry/index.json and release/<ref>/; failure throws GIT_COMMIT_FAILED (CLI).
 *   gitCommitSoft: same, but only when `root` is inside a git work tree, and a failure never fails the publish:
 *   the result carries `gitWarning` instead (used by the web app).
 */
export function approve(draftRef, approval = {}, opts = {}) {
  const trainer = typeof approval.trainer === 'string' ? approval.trainer.trim() : '';
  if (!trainer) throw new FactoryError('Say who is approving: a Trainer must put their name on the approval (--trainer "Name").', 'TRAINER_REQUIRED');
  const { id, version } = parseRef(draftRef);
  const root = rootOf(opts);
  const draft = loadDraft(draftRef, opts);
  const sha = digestOf(draft.template);

  const q = readQualification(draftRef, opts);
  if (!q) throw new FactoryError(`${draftRef} has not been qualified. Run: node factory.mjs qualify ${draftRef}`, 'NOT_QUALIFIED');
  if (q.draftSha256 !== sha) {
    throw new FactoryError(`${draftRef} was changed after it was qualified, so the qualification no longer applies. Qualify it again: node factory.mjs qualify ${draftRef}`, 'STALE_QUALIFICATION');
  }
  if (!q.allPass) {
    const failed = q.results.filter((r) => r.status !== 'PASS').map((r) => r.testId);
    throw new FactoryError(`${draftRef} did not pass every test (failed: ${failed.join(', ') || 'none recorded'}). Fix the lesson and train again.`, 'QUALIFICATION_FAILED');
  }
  const compiled = compile(draftRef, { ...opts, allowDraft: true });
  if (compiled.effectiveSha256 !== q.effectiveSha256) {
    throw new FactoryError(`The definition behind ${draftRef} changed since it was qualified. Qualify it again.`, 'STALE_QUALIFICATION');
  }
  const templateFile = path.join(root, 'templates', `${draftRef}.json`);
  if (findEntry(loadRegistry(opts), 'template', id, version)) {
    throw new FactoryError(`${draftRef} is already released. Released versions never change.`, 'VERSION_EXISTS');
  }
  // Recovery: a crash after the template file was copied but before the registry entry was added leaves identical
  // bytes on disk and no registry entry. That is a half-finished publish of THIS draft, so it is completed. Any
  // other content at that path is a real collision and is refused.
  if (existsSync(templateFile) && !readFileSync(templateFile).equals(readFileSync(draftPath(draftRef, opts)))) {
    throw new FactoryError(`${draftRef} is already released. Released versions never change.`, 'VERSION_EXISTS');
  }

  const at = new Date().toISOString();
  const relTemplate = `templates/${draftRef}.json`;
  const releaseDir = path.join(root, 'release', draftRef);
  mkdirSync(releaseDir, { recursive: true });
  // 1. release bundle (manifest + checksums), 2. template file, 3. registry entry (the commit point).
  copyFileSync(qualificationPath(draftRef, opts), path.join(releaseDir, 'qualification.json'));
  copyFileSync(draftPath(draftRef, opts), path.join(releaseDir, 'template.json'));
  const manifest = {
    templateRef: { id, version, sha256: sha },
    parent: draft.template.parent,
    effectiveSha256: compiled.effectiveSha256,
    approval: { trainer, at },
    qualification: { allPass: true, at: q.at, tests: q.results.length, fileSha256: fileSha(path.join(releaseDir, 'qualification.json')) }
  };
  writeFileSync(path.join(releaseDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const sums = ['manifest.json', 'qualification.json', 'template.json'].map((f) => `${fileSha(path.join(releaseDir, f))}  ${f}`);
  writeFileSync(path.join(releaseDir, 'SHA256SUMS'), sums.join('\n') + '\n');
  copyFileSync(draftPath(draftRef, opts), path.join(root, relTemplate));
  addEntry({ kind: 'template', id, version, path: relTemplate, sha256: sha }, opts);
  // Re-compile from the released registry to prove the release is sound.
  const released = compile(draftRef, { ...opts, allowDraft: false });
  if (released.effectiveSha256 !== compiled.effectiveSha256) {
    throw new FactoryError(`${draftRef} was published but compiles differently from the qualified draft. Do not use it; contact the SAFI administrator.`, 'PUBLISH_MISMATCH');
  }
  writeFileSync(approvalPath(draftRef, opts), JSON.stringify({ draftRef, trainer, at, sha256: sha }, null, 2) + '\n');
  const out = { draftRef, trainer, at, sha256: sha, effectiveSha256: released.effectiveSha256, templatePath: relTemplate, releaseDir: `release/${draftRef}` };
  if (opts.gitCommit) out.gitCommit = gitCommitRelease(root, draftRef, trainer, relTemplate);
  else if (opts.gitCommitSoft && insideGitWorkTree(root)) {
    try {
      out.gitCommit = gitCommitRelease(root, draftRef, trainer, relTemplate);
    } catch (e) {
      out.gitWarning = e.message;
    }
  }
  return out;
}

export function insideGitWorkTree(root) {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'pipe' }).toString().trim() === 'true';
  } catch {
    return false;
  }
}

function gitCommitRelease(root, draftRef, trainer, relTemplate) {
  const paths = [relTemplate, 'registry/index.json', `release/${draftRef}`];
  try {
    execFileSync('git', ['add', '--', ...paths], { cwd: root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `publish ${draftRef} approved by ${trainer}`, '--', ...paths], { cwd: root, stdio: 'pipe' });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: 'pipe' }).toString().trim();
  } catch (e) {
    throw new FactoryError(`${draftRef} was published, but saving it to git failed (${String(e.stderr ?? e.message).trim().slice(0, 200)}). Commit templates/, registry/ and release/ by hand.`, 'GIT_COMMIT_FAILED');
  }
}
