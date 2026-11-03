// Release manifest: SHA-256 of every file that makes up a release of the Factory, plus the git SHA.
//
//   npm run release:manifest              write release/RELEASE-MANIFEST.json
//   node scripts/release-manifest.mjs --check   re-hash the files and compare with the committed manifest
//
// Files covered: templates, skills, knowledge, registry, schemas, config, factory + lib + server + scripts +
// deploy-office + office/, openapi.yaml, client sources and client/dist, fixtures, tests, package.json and the
// package-lock files. Hashes are of the raw bytes (what `sha256sum` prints). The git SHA is the commit the files
// were built from; committing the manifest creates a later commit, so the manifest cannot name its own commit.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../lib/compiler.mjs';
import { loadRegistry } from '../lib/registry.mjs';
import { hashObject, sha256Hex } from '../lib/canonical.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MANIFEST_PATH = 'release/RELEASE-MANIFEST.json';

// Folders walked recursively and single files included. Order is irrelevant: output is sorted.
const FOLDERS = ['templates', 'skills', 'knowledge', 'registry', 'schemas', 'config', 'lib', 'server', 'scripts', 'office', 'client/src', 'client/dist', 'fixtures', 'tests'];
const FILES = ['factory.mjs', 'deploy-office.mjs', 'openapi.yaml', 'package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json', 'client/index.html', 'client/vite.config.js'];
// Never hashed: local secrets and machine-specific settings.
const SKIP = [/(^|\/)\.env/, /(^|\/)office\.json$/, /(^|\/)node_modules\//, /\.pem$/, /passcodes/i];

function walk(rel) {
  const abs = path.join(REPO, rel);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

export function collectFiles() {
  const all = new Set(FILES.filter((f) => existsSync(path.join(REPO, f))));
  for (const folder of FOLDERS) for (const f of walk(folder)) all.add(f);
  return [...all].filter((f) => !SKIP.some((re) => re.test(f))).sort();
}

function git(args, trim = true) {
  try {
    const out = execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return trim ? out.trim() : out.replace(/
+$/, '');
  } catch {
    return null;
  }
}

/** Dirty = any tracked change or untracked file other than the release outputs this script and acceptance.mjs write. */
export function gitState() {
  const sha = git(['rev-parse', 'HEAD']);
  const porcelain = git(['status', '--porcelain'], false);
  if (sha === null || porcelain === null) return { gitSha: sha, dirty: null, dirtyFiles: null };
  const generated = [MANIFEST_PATH, 'ACCEPTANCE.json', 'evidence/', 'service-expert.manifest.json'];
  const dirtyFiles = porcelain
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ''))
    .filter((f) => !generated.some((g) => f === g || f.startsWith(g)));
  return { gitSha: sha, dirty: dirtyFiles.length > 0, dirtyFiles };
}

export function buildManifest() {
  const files = {};
  for (const rel of collectFiles()) files[rel] = sha256Hex(readFileSync(path.join(REPO, rel)));
  const registry = loadRegistry();
  const templates = registry
    .filter((e) => e.kind === 'template')
    .map((e) => ({ ref: `${e.id}@${e.version}`, digest: e.sha256, effectiveSha256: compile(`${e.id}@${e.version}`).effectiveSha256 }));
  const group = (prefix) => Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(prefix)));
  const state = gitState();
  return {
    kind: 'safi-release-manifest',
    service: 'SAFI Service 017 Born-Smart Agent Factory',
    version: JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
    generatedAt: new Date().toISOString(),
    gitSha: state.gitSha,
    dirty: state.dirty,
    dirtyFiles: state.dirtyFiles,
    node: process.version,
    packageLockSha256: files['package-lock.json'],
    clientPackageLockSha256: files['client/package-lock.json'],
    registryIndexSha256: files['registry/index.json'],
    clientDistFiles: Object.keys(group('client/dist/')).length,
    clientDistSha256: hashObject(group('client/dist/')),
    templates,
    fileCount: Object.keys(files).length,
    filesSha256: hashObject(files),
    files
  };
}

const EXPERT_PATH = 'service-expert.manifest.json';

/** Fill the computed fields of the Service Expert manifest (git SHA, document hashes). Everything else is left as written. */
function updateExpertManifest(m) {
  const file = path.join(REPO, EXPERT_PATH);
  if (!existsSync(file)) return false;
  const e = JSON.parse(readFileSync(file, 'utf8'));
  const fileSha = (p) => (existsSync(path.join(REPO, p)) ? sha256Hex(readFileSync(path.join(REPO, p))) : null);
  e.source.gitSha = m.gitSha;
  e.source.dirty = m.dirty;
  e.source.releaseManifestFilesSha256 = m.filesSha256;
  for (const doc of Object.values(e.documents)) if ('sha256' in doc) doc.sha256 = fileSha(doc.path);
  writeFileSync(file, JSON.stringify(e, null, 2) + '\n');
  return true;
}

function check() {
  const file = path.join(REPO, MANIFEST_PATH);
  if (!existsSync(file)) {
    console.error(`${MANIFEST_PATH} does not exist. Run: npm run release:manifest`);
    return 1;
  }
  const committed = JSON.parse(readFileSync(file, 'utf8'));
  const now = Object.fromEntries(collectFiles().map((rel) => [rel, sha256Hex(readFileSync(path.join(REPO, rel)))]));
  const problems = [];
  for (const [rel, sha] of Object.entries(committed.files)) {
    if (!(rel in now)) problems.push(`missing: ${rel}`);
    else if (now[rel] !== sha) problems.push(`changed: ${rel}`);
  }
  for (const rel of Object.keys(now)) if (!(rel in committed.files)) problems.push(`new file: ${rel}`);
  if (problems.length) {
    console.error(`The release manifest no longer matches the files (${problems.length} differences):\n${problems.slice(0, 40).join('\n')}`);
    return 1;
  }
  console.log(`OK: ${Object.keys(now).length} files match ${MANIFEST_PATH} (built from git ${committed.gitSha?.slice(0, 10)}).`);
  return 0;
}

function main() {
  if (process.argv.includes('--check')) {
    process.exitCode = check();
    return;
  }
  if (!existsSync(path.join(REPO, 'client', 'dist', 'index.html'))) {
    console.error('The web app has not been built (client/dist is missing), so it cannot be part of the manifest. Run "npm run build" first.');
    process.exitCode = 1;
    return;
  }
  const m = buildManifest();
  mkdirSync(path.join(REPO, 'release'), { recursive: true });
  writeFileSync(path.join(REPO, MANIFEST_PATH), JSON.stringify(m, null, 2) + '\n');
  const expert = updateExpertManifest(m);
  console.log(`Wrote ${MANIFEST_PATH}: ${m.fileCount} files, git ${m.gitSha?.slice(0, 10) ?? 'unknown'}${m.dirty ? ' (working tree has uncommitted changes)' : ''}, filesSha256 ${m.filesSha256.slice(0, 16)}...${expert ? ` Updated ${EXPERT_PATH}.` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
