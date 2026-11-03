// Local Office simulation: build the real deployment bundle, extract it to .office-local/app and run it in
// SAFI_MODE=office with its own data folder, exactly as the systemd unit would (minus AWS).
//
//   npm run office:local            build bundle, extract, run on http://127.0.0.1:8018
//   node scripts/office-local.mjs --no-run     prepare only
//   node scripts/office-local.mjs --install    use `npm ci --omit=dev` inside the app folder instead of linking node_modules
//
// Stop it (Ctrl+C) and start it again: data in .office-local/data survives, which is the restart-persistence demo.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { buildBundle } from '../deploy-office.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Build the bundle from `root`, extract into `<base>/app`. Returns { appDir, dataDir, built }. */
export function prepareOfficeLocal({ root = REPO, base = path.join(root, '.office-local'), install = false, gitSha, nodeModules = path.join(root, 'node_modules') } = {}) {
  const built = buildBundle({ root, outDir: path.join(base, 'bundle'), gitSha });
  const appDir = path.join(base, 'app');
  const dataDir = path.join(base, 'data');
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  tar.x({ file: built.bundlePath, cwd: appDir, sync: true });
  if (install) {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) throw new Error('npm ci failed inside .office-local/app. Check your network and try again, or run without --install to reuse the repo node_modules.');
  } else {
    symlinkSync(nodeModules, path.join(appDir, 'node_modules'), 'junction');
  }
  return { appDir, dataDir, built };
}

/** Child-process environment for the simulated Office. Secrets come only from the repo .env / the caller's env. */
export function officeEnv({ dataDir, port = 8018, gitSha, env = process.env }) {
  return { ...env, SAFI_MODE: 'office', SAFI_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', ...(gitSha ? { GIT_SHA: gitSha } : {}) };
}

function main() {
  const args = process.argv.slice(2);
  const port = Number(process.env.OFFICE_LOCAL_PORT ?? 8018);
  if (!existsSync(path.join(REPO, 'client', 'dist'))) {
    console.error('The web app has not been built yet. Run "npm run build" first, then "npm run office:local".');
    process.exit(1);
  }
  const { appDir, dataDir, built } = prepareOfficeLocal({ install: args.includes('--install') });
  console.log(`Office bundle ${built.gitSha} (${built.files.length} files, sha256 ${built.bundleSha256.slice(0, 12)}...) extracted to ${appDir}`);
  console.log(`Office data folder: ${dataDir}`);
  if (args.includes('--no-run')) return;
  const envFile = path.join(REPO, '.env');
  const nodeArgs = [...(existsSync(envFile) ? [`--env-file=${envFile}`] : []), 'server/index.mjs'];
  const child = spawn(process.execPath, nodeArgs, { cwd: appDir, env: officeEnv({ dataDir, port, gitSha: built.gitSha }), stdio: 'inherit' });
  console.log(`Starting the simulated Office at http://127.0.0.1:${port} (Ctrl+C to stop; start it again to prove data persists).`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
