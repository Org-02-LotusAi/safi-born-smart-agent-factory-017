// Passcodes, signed cookie sessions and the instance-owner index. No third-party auth: two roles, two passcodes.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const COOKIE = 'safi_session';
export const SESSION_HOURS = 12;

/** Constant-time string compare (hashes first so lengths never leak). */
export function safeEqual(a, b) {
  const ha = createHmac('sha256', 'safi-compare').update(String(a)).digest();
  const hb = createHmac('sha256', 'safi-compare').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');

/** SESSION_SECRET from env, else a generated one stored once in data/. */
export function resolveSecret(env, dataDir) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const file = path.join(dataDir, 'session-secret');
  const have = readText(file);
  if (have) return have;
  mkdirSync(dataDir, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

/**
 * Passcodes from env; if either is unset, generate a random one, write both to data/passcodes.local.txt
 * and print the generated ones once. They are never stored anywhere else.
 */
export function resolvePasscodes(env, dataDir, { quiet = false, log = console.log } = {}) {
  let candidate = env.CANDIDATE_PASSCODE;
  let trainer = env.TRAINER_PASSCODE;
  if (!candidate || !trainer) {
    const generated = [];
    if (!candidate) { candidate = randomBytes(6).toString('base64url'); generated.push('candidate'); }
    if (!trainer) { trainer = randomBytes(6).toString('base64url'); generated.push('trainer'); }
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, 'passcodes.local.txt'), generated.map((g) => `${g}: ${g === 'candidate' ? candidate : trainer}\n`).join(''), { mode: 0o600 });
    if (!quiet) {
      log(`No ${generated.join(' / ')} passcode was set in the environment, so random ones were made (shown once):`);
      if (generated.includes('candidate')) log(`  Job seeker passcode:   ${candidate}`);
      if (generated.includes('trainer')) log(`  SAFI Trainer passcode: ${trainer}`);
      log('  They are also saved in data/passcodes.local.txt. Set CANDIDATE_PASSCODE and TRAINER_PASSCODE in .env to choose your own.');
    }
  }
  return { candidate, trainer };
}

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function makeToken(secret, session) {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the session object or null (bad signature, expired, malformed). */
export function readToken(secret, token) {
  if (typeof token !== 'string') return null;
  const [payload, mac, extra] = token.split('.');
  if (!payload || !mac || extra !== undefined || !safeEqual(sign(secret, payload), mac)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!['candidate', 'trainer'].includes(s.role) || typeof s.exp !== 'number' || s.exp < Date.now()) return null;
    if (cleanName(s.name) === null) return null; // a session without a real name is never valid
    return s;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore a malformed cookie */ }
    }
  }
  return out;
}

/** A sign-in name: trimmed, whitespace collapsed, 1-80 characters. Returns null when it is not acceptable. */
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  return n.length >= 1 && n.length <= 80 ? n : null;
}

/** Owner label used by the server-side index: role plus the name typed at sign-in. Never falls back to a shared default. */
export function ownerLabel(role, name) {
  const n = cleanName(name);
  if (n === null) throw new Error('ownerLabel needs a real name');
  return `${role}:${n.toLowerCase()}`;
}

/** data/instance-owners.json: { [instanceId]: ownerLabel }. Kept outside the immutable manifest on purpose. */
export class OwnerIndex {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'instance-owners.json');
  }

  all() {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  get(instanceId) {
    return this.all()[instanceId] ?? null;
  }

  set(instanceId, owner) {
    const all = this.all();
    all[instanceId] = owner;
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    renameSync(tmp, this.file);
  }
}
