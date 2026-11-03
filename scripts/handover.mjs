// Handover: run after the dogfood session and after the real release has been committed.
//
//   npm run handover
//
// 1. regenerates the release manifest (also refreshes service-expert.manifest.json),
// 2. runs the offline acceptance checks (live results from the last live run are carried forward, not re-run),
// 3. prints the git SHA, a status table and the checklist of items only people can finish.
// It never commits. After it runs: review `git status`, commit the regenerated files (plain `git commit`), and
// record the SHA that `git rev-parse HEAD` then prints: that is the final handover SHA.
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function step(title, args) {
  console.log(`\n=== ${title} ===`);
  const r = spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit' });
  return r.status ?? 1;
}

const git = (...a) => {
  try {
    return execFileSync('git', a, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};

/** Items only people can finish, read from the repo so the list cannot go stale. */
export function pendingHumanItems(root = REPO) {
  const items = [];
  const acc = path.join(root, 'ACCEPTANCE.json');
  const checks = existsSync(acc) ? JSON.parse(readFileSync(acc, 'utf8')).checks ?? [] : [];
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  if (!by.A09 || by.A09.status !== 'PASS') items.push(`A09 Office: ${by.A09?.status ?? 'missing'}. Provision the SOW 016 Office (docs/AWS-REQUIREMENTS.md), create config/office.json, deploy, restart, and attach the logs (docs/RUNBOOK.md).`);
  const dog = path.join(root, 'DOGFOOD.md');
  if (!by.A11 || by.A11.status !== 'PASS') {
    const blanks = existsSync(dog) ? (readFileSync(dog, 'utf8').match(/_{6,}/g) ?? []).length : null;
    items.push(`A11 dogfood: ${by.A11?.status ?? 'missing'}${blanks === null ? '' : `, ${blanks} blank fields left in DOGFOOD.md`}. Two people run the 30-minute session (DOGFOOD.md), fill every field, mark Status: PERFORMED.`);
  }
  const model = path.join(root, 'MODEL.md');
  if (existsSync(model) && /Approved by \(name, role\):\s*_{4,}/.test(readFileSync(model, 'utf8'))) {
    items.push('MODEL.md approval line is blank: the customer representative must name who approved sending data to the hosted model (name, role, date, spend cap). Until then only synthetic data may be used.');
  }
  for (const c of checks) {
    if (['A09', 'A11'].includes(c.id)) continue;
    for (const p of c.pendingEvidence ?? []) items.push(`${c.id} ${c.status}: ${p}`);
  }
  const reg = path.join(root, 'registry', 'index.json');
  if (existsSync(reg) && !JSON.parse(readFileSync(reg, 'utf8')).some((e) => e.kind === 'template' && e.id === 'safi.cs-graduate-jobseeker' && e.version === '1.0.1')) {
    items.push('T2 v1.0.1 is not published in this repository yet (DOGFOOD step 5, done by the human Trainer). Do this BEFORE running handover so the manifest and acceptance cover it.');
  }
  return items;
}

function main() {
  if (!existsSync(path.join(REPO, 'client', 'dist', 'index.html'))) {
    console.error('The web app is not built. Run "npm run build" first.');
    process.exitCode = 1;
    return;
  }
  const rc = [
    step('Release manifest', ['scripts/release-manifest.mjs']),
    step('Offline acceptance', ['--env-file-if-exists=.env', 'scripts/acceptance.mjs'])
  ];
  const acc = path.join(REPO, 'ACCEPTANCE.json');
  const summary = existsSync(acc) ? JSON.parse(readFileSync(acc, 'utf8')) : null;

  console.log('\n=== Handover summary ===');
  if (summary) {
    for (const c of summary.checks) console.log(`  ${c.id}  ${c.status.padEnd(13)} ${c.title}${c.carriedForward ? `  [live result from ${c.carriedForward.liveRunAt}]` : ''}`);
    console.log(`  counts: ${Object.entries(summary.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
  const head = git('rev-parse', 'HEAD');
  const dirty = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean);
  console.log(`\nGit HEAD right now: ${head ?? 'unknown (not a git repository)'}`);
  if (dirty.length) {
    console.log(`The regenerated files are not committed yet (${dirty.length} changed paths). Next:\n  git add -A   (check "git status" first; never add data/ or .env)\n  git commit -m "handover: manifest and acceptance"\n  git rev-parse HEAD   <- this is the final handover SHA; write it in the handover note.`);
  } else {
    console.log('The working tree is clean: the SHA above is the final handover SHA.');
  }

  const items = pendingHumanItems();
  console.log(`\nStill needs a person (${items.length}):`);
  if (!items.length) console.log('  nothing');
  items.forEach((x, i) => console.log(`  ${i + 1}. [ ] ${x}`));

  if (rc.some((c) => c !== 0)) {
    console.error('\nA step above failed. Fix it and run handover again before handing over.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
