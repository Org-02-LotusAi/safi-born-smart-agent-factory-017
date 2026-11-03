// HTTP API for the SAFI Factory / Office. Every handler calls factory.mjs exported functions only;
// there is no compile / instantiate / train / qualify / publish logic in this folder.
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as factory from '../factory.mjs';
import { ApiError, errorBody, toApiError } from './errors.mjs';
import { Jobs } from './jobs.mjs';
import { COOKIE, OwnerIndex, cleanName, SESSION_HOURS, makeToken, ownerLabel, parseCookies, readToken, resolvePasscodes, resolveSecret, safeEqual } from './auth.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '/api/v1';
const OFFICE_MESSAGE = 'Training is done in the SAFI Factory, not in the Office.';
const MAX_TEXT = 60_000;
const DEPLOY_MODES = ['dry-run', 'deploy', 'status', 'restart'];

const str = (v, max = 4000) => typeof v === 'string' && v.length <= max;
const bad = (message, hint = 'Check what you entered and try again.') => new ApiError(400, 'BAD_REQUEST', message, hint);

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return process.env.GIT_SHA ?? null;
  }
}

/**
 * createApp(opts) -> express app
 * opts: { root, dataDir, llm (stub model), model, mode ('factory'|'office'), env, passcodes {candidate,trainer},
 *         clientDist, deployModule (injected for tests), quiet }
 */
export function createApp(opts = {}) {
  const env = opts.env ?? process.env;
  const root = path.resolve(opts.root ?? REPO);
  const dataDir = path.resolve(opts.dataDir ?? env.SAFI_DATA_DIR ?? path.join(root, 'data'));
  const mode = (opts.mode ?? env.SAFI_MODE ?? 'factory') === 'office' ? 'office' : 'factory';
  const quiet = opts.quiet ?? false;
  const log = (level, msg, err) => {
    if (quiet) return;
    console[level === 'error' ? 'error' : 'log'](`[safi] ${msg}${err ? ` :: ${err.name}: ${err.message}\n${err.stack ?? ''}` : ''}`);
  };
  const secret = opts.secret ?? resolveSecret(env, dataDir);
  const passcodes = opts.passcodes ?? resolvePasscodes(env, dataDir, { quiet });
  const clientDist = path.resolve(opts.clientDist ?? path.join(REPO, 'client', 'dist'));
  const owners = new OwnerIndex(dataDir);
  const jobs = new Jobs({ log });
  const fo = { root, dataDir, ...(opts.llm ? { llm: opts.llm } : {}), ...(opts.model ? { model: opts.model } : {}) };
  const modelFn = opts.llm ?? factory.callModel;
  const failures = new Map(); // ip -> { count, resetAt }: slows passcode guessing

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // ---- security headers, request id, logging ----
  app.use((req, res, next) => {
    req.id = Math.random().toString(36).slice(2, 10);
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (req.path.startsWith(BASE)) res.setHeader('Cache-Control', 'no-store');
    const t0 = Date.now();
    res.on('finish', () => log('info', `${req.id} ${req.method} ${req.path} ${res.statusCode} ${Date.now() - t0}ms`));
    next();
  });

  // ---- CSRF: every mutating API call must carry X-SAFI-Request: 1 (cookie is also SameSite=Strict) ----
  app.use(BASE, (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('X-SAFI-Request') !== '1') {
      return next(new ApiError(403, 'CSRF_BLOCKED', 'This request was blocked because it did not come from the SAFI app.', 'Reload the page and try again.'));
    }
    next();
  });
  app.use(BASE, express.json({ limit: '200kb' }));

  // ---- session ----
  app.use(BASE, (req, _res, next) => {
    const s = readToken(secret, parseCookies(req.headers.cookie)[COOKIE]);
    req.session = s ? { role: s.role, name: cleanName(s.name), owner: ownerLabel(s.role, s.name) } : null;
    next();
  });

  const need = (req) => {
    if (!req.session) throw new ApiError(401, 'NOT_SIGNED_IN', 'Please sign in first.', 'Choose "I\'m a job seeker" or "I\'m a SAFI Trainer" and enter the passcode.');
    return req.session;
  };
  const authenticated = (req, _res, next) => { need(req); next(); };
  const authoring = (req, _res, next) => {
    if (mode === 'office') throw new ApiError(403, 'OFFICE_MODE', OFFICE_MESSAGE, 'Ask the SAFI Trainer to make and publish changes in the Factory, then deploy them to the Office.');
    const s = need(req);
    if (s.role !== 'trainer') throw new ApiError(403, 'TRAINER_ONLY', 'Only a SAFI Trainer can do this.', 'Sign in as a SAFI Trainer.');
    next();
  };
  const route = (method, p, ...handlers) => app[method](BASE + p, ...handlers.map((h) => async (req, res, next) => {
    try { await h(req, res, next); } catch (e) { next(e); }
  }));

  // ---- instance access: owner only; a trainer sees other people's manifests but never their profile or runs ----
  const loadOwned = (req, { allowManifestOnly = false } = {}) => {
    const s = need(req);
    const id = req.params.id;
    const { manifest, profile } = factory.getInstance(id, fo); // 404 if unknown
    const owner = owners.get(id);
    const isOwner = owner === s.owner;
    if (isOwner) return { manifest, profile, isOwner };
    if (s.role === 'trainer' && allowManifestOnly) return { manifest, profile: null, isOwner };
    if (s.role === 'trainer') {
      throw new ApiError(403, 'PRIVATE', 'For privacy, only the person who created this agent can see their profile and results.', 'You can still see which agents exist and which template version each one uses.');
    }
    throw new ApiError(404, 'INSTANCE_NOT_FOUND', `No agent with id ${id} was found for you. Check the id or create a new agent.`, 'Open "My coaches" to see your agents.');
  };

  const jobAccess = (job, s) => job.owner === s.owner || (s.role === 'trainer' && ['train', 'qualify', 'deploy'].includes(job.kind));
  const accepted = (res, started) => {
    if (started.tooBusy) throw new ApiError(429, 'TOO_BUSY', 'The AI is already busy with several jobs.', 'Wait a minute and try again.');
    res.status(202).json({ jobId: started.job.jobId, status: started.job.status, existing: started.existing });
  };
  const countingLlm = (update, label, total) => {
    let n = 0;
    return async (args) => {
      n += 1;
      update(`${label}: asking the AI, step ${total ? `${Math.min(n, total)} of ${total}` : n}.`);
      return modelFn(args);
    };
  };

  // ======================= routes =======================
  route('get', '/health', (_req, res) => {
    res.json({
      status: 'ok', mode,
      version: JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).version,
      gitSha: gitSha(),
      model: env.LLM_MODEL ?? factory.DEFAULT_MODEL,
      templates: factory.loadRegistry(fo).filter((e) => e.kind === 'template').length
    });
  });

  route('post', '/session', (req, res) => {
    const { role, passcode, name } = req.body ?? {};
    if (!['candidate', 'trainer'].includes(role) || !str(passcode, 200)) {
      throw bad('Choose a role and type the passcode.', 'Choose "I\'m a job seeker" or "I\'m a SAFI Trainer" and enter the passcode you were given.');
    }
    const cleaned = cleanName(name);
    if (cleaned === null) {
      throw bad(role === 'trainer' ? 'Please type your name. It is recorded on every release you approve.' : 'Please type your name so your agents and results stay separate from other people\'s.',
        'Use 1 to 80 characters, for example your first and last name.');
    }
    const ip = req.ip ?? 'unknown';
    for (const [k, v] of failures) if (v.resetAt <= Date.now()) failures.delete(k);
    const f = failures.get(ip);
    if (f && f.count >= 8 && f.resetAt > Date.now()) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong passcodes in a row.', 'Wait ten minutes, then try again.');
    }
    if (!passcode || !safeEqual(passcode, passcodes[role])) {
      failures.set(ip, { count: (f && f.resetAt > Date.now() ? f.count : 0) + 1, resetAt: f && f.resetAt > Date.now() ? f.resetAt : Date.now() + 10 * 60_000 });
      throw new ApiError(401, 'WRONG_PASSCODE', 'That passcode is not right.', 'Check it and try again, or ask the SAFI Trainer for the passcode.');
    }
    failures.delete(ip);
    const exp = Date.now() + SESSION_HOURS * 3600_000;
    const token = makeToken(secret, { role, name: cleaned, exp });
    const secure = env.COOKIE_SECURE === '1' ? '; Secure' : '';
    res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}${secure}`);
    res.status(201).json({ role, name: cleaned, mode });
  });

  route('delete', '/session', (_req, res) => {
    res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.status(204).end();
  });

  route('get', '/me', (req, res) => {
    res.json({ authenticated: !!req.session, role: req.session?.role ?? null, name: req.session?.name ?? null, mode });
  });

  route('get', '/templates', authenticated, (req, res) => {
    const includeDrafts = req.session.role === 'trainer' && mode === 'factory';
    res.json({ templates: factory.listTemplateTree({ ...fo, includeDrafts }) });
  });

  const canSeeDrafts = (req) => req.session.role === 'trainer' && mode === 'factory';
  route('get', '/templates/:ref', authenticated, (req, res) => {
    res.json(factory.templateView(req.params.ref, { ...fo, allowDraft: canSeeDrafts(req) }));
  });

  route('post', '/compile', authenticated, (req, res) => {
    const { templateRef } = req.body ?? {};
    if (!str(templateRef, 200)) throw bad('Say which template to check, for example safi.agent@1.0.0.');
    res.json(factory.compile(templateRef, { ...fo, allowDraft: canSeeDrafts(req) }));
  });

  route('get', '/fixtures/demo', authenticated, (_req, res) => {
    res.json({ ...factory.demoFixture(fo), jobFixtures: factory.listJobFixtures(fo) });
  });

  // ---- agents (instances) ----
  route('post', '/instances', authenticated, (req, res) => {
    const { templateRef, config, name } = req.body ?? {};
    if (!str(templateRef, 200) || !config || typeof config !== 'object' || Array.isArray(config) || (name !== undefined && !str(name, 120))) {
      throw bad('Send a template reference and the candidate profile.', 'Pick a template and fill in the profile form.');
    }
    const manifest = factory.instantiate(templateRef, config, { ...fo, name: name?.trim() || undefined });
    owners.set(manifest.instanceId, req.session.owner);
    res.status(201).json(manifest);
  });

  route('get', '/instances', authenticated, (req, res) => {
    const s = req.session;
    const index = owners.all();
    const list = factory.listInstances(fo)
      .filter((m) => s.role === 'trainer' || index[m.instanceId] === s.owner)
      .map((m) => ({ ...m, owned: index[m.instanceId] === s.owner }));
    res.json({ instances: list });
  });

  route('get', '/instances/:id', authenticated, (req, res) => {
    const { manifest, profile, isOwner } = loadOwned(req, { allowManifestOnly: true });
    res.json({ manifest, profile, owned: isOwner, profileHidden: !isOwner });
  });

  const resolveJobInput = (body) => {
    const j = body.job;
    if (!j || typeof j !== 'object') throw bad('Paste a job posting so the agent has something to compare with.', 'Paste the job text, or choose a sample job.');
    let job;
    if (j.fixture !== undefined) {
      if (!factory.listJobFixtures(fo).includes(j.fixture)) throw bad('That sample job does not exist.', 'Choose one of the sample jobs from the list.');
      job = j.fixture;
    } else {
      if (!str(j.text, MAX_TEXT) || !j.text.trim()) throw bad(`The job posting is empty or too long (limit ${MAX_TEXT} characters).`, 'Paste the text of one job posting.');
      if ((j.url !== undefined && !str(j.url, 500)) || (j.accessDate !== undefined && !str(j.accessDate, 40))) throw bad('The job URL or access date is not valid.');
      job = { text: j.text, url: j.url, accessDate: j.accessDate };
    }
    if (body.resumeText !== undefined && !str(body.resumeText, MAX_TEXT)) throw bad(`The resume text is too long (limit ${MAX_TEXT} characters).`, 'Paste only the text of your resume.');
    if (body.task !== undefined && !str(body.task, 1000)) throw bad('The task is too long.', 'Keep the request to a sentence or two.');
    return { job, resumeText: body.resumeText || undefined, task: body.task?.trim() || 'Compare my profile to this job posting.' };
  };

  route('post', '/instances/:id/runs', authenticated, (req, res) => {
    const { manifest } = loadOwned(req);
    const input = resolveJobInput(req.body ?? {});
    accepted(res, jobs.start({
      kind: 'run', owner: req.session.owner, progressText: 'Queued. The agent is about to read your profile and the job.',
      work: async (update) => {
        update('The agent is comparing your profile with the job. This usually takes 30 to 60 seconds.');
        return factory.run(manifest.instanceId, input.task, { ...fo, job: input.job, resumeText: input.resumeText });
      }
    }));
  });

  const summary = (r, approval) => ({
    runId: r.runId, kind: r.kind, status: r.status, stage: r.stage ?? null, reasons: r.reasons ?? [], task: r.task, startedAt: r.startedAt, finishedAt: r.finishedAt,
    model: r.model ?? r.requestedModel, templateRef: r.templateRef, approved: !!approval, approvedAt: approval?.approvedAt ?? null
  });

  route('get', '/instances/:id/runs', authenticated, (req, res) => {
    const { manifest } = loadOwned(req);
    const runs = factory.listRuns(manifest.instanceId, fo).filter((r) => r.kind === 'run');
    res.json({ runs: runs.map((r) => summary(r, factory.runApproval(manifest.instanceId, r.runId, fo))).reverse() });
  });

  route('get', '/instances/:id/runs/:runId', authenticated, (req, res) => {
    const { manifest } = loadOwned(req);
    const record = factory.getRun(manifest.instanceId, req.params.runId, fo);
    res.json({ run: record, approval: factory.runApproval(manifest.instanceId, record.runId, fo) });
  });

  route('post', '/instances/:id/runs/:runId/approve', authenticated, (req, res) => {
    const { manifest } = loadOwned(req);
    res.json(factory.approveOutput(manifest.instanceId, req.params.runId, fo));
  });

  route('get', '/instances/:id/runs/:runId/export', authenticated, (req, res) => {
    const { manifest } = loadOwned(req);
    res.json(factory.exportOutput(manifest.instanceId, req.params.runId, fo));
  });

  route('post', '/instances/:id/runs/:runId/interview-feedback', authenticated, async (req, res) => {
    const { manifest } = loadOwned(req);
    const { questionIndex, answer } = req.body ?? {};
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || !str(answer, 6000)) {
      throw bad('Choose a question and type your practice answer (up to 6000 characters).', 'Type your answer in the box, then ask for feedback.');
    }
    res.json(await factory.interviewFeedback(manifest.instanceId, { runId: req.params.runId, questionIndex, answer }, fo));
  });

  // ---- training (trainer only; refused in Office mode) ----
  route('post', '/drafts', authoring, (req, res) => {
    const { templateRef, lesson, replace } = req.body ?? {};
    if (!str(templateRef, 200) || !str(lesson, 4000) || !lesson.trim()) throw bad('Pick a template and write the lesson in plain English (up to 4000 characters).', 'For example: "A capstone project is not paid employment."');
    accepted(res, jobs.start({
      kind: 'train', owner: req.session.owner, key: `train:${templateRef}`, progressText: 'Queued. The AI is about to propose a change.',
      work: async (update) => {
        update('The AI is reading the lesson and proposing a change. This usually takes under a minute.');
        return factory.train(templateRef, lesson, { ...fo, replaceDraft: replace === true });
      }
    }));
  });

  route('get', '/drafts', authoring, (_req, res) => {
    res.json({ drafts: factory.listDrafts(fo).map((d) => ({ ...d, qualification: d.status === 'INVALID' ? null : factory.readQualification(d.draftRef, fo) })) });
  });

  route('post', '/drafts/:ref/qualify', authoring, (req, res) => {
    const ref = req.params.ref;
    factory.loadDraft(ref, fo); // 404 now, not inside the job
    const total = factory.compile(ref, { ...fo, allowDraft: true }).effective.tests.filter((t) => t.kind === 'behavioral').length;
    accepted(res, jobs.start({
      kind: 'qualify', owner: req.session.owner, key: `qualify:${ref}`, progressText: 'Queued. About to run every test.',
      work: async (update) => {
        update(`Running all tests. ${total} of them use the live AI, so this takes about 3 to 4 minutes.`);
        return factory.qualify(ref, { ...fo, llm: countingLlm(update, 'Qualifying', total) });
      }
    }));
  });

  route('post', '/drafts/:ref/approve', authoring, (req, res) => {
    const trainer = (req.body?.trainer ?? req.session.name ?? '').toString().trim();
    if (!str(trainer, 120)) throw bad('Type the Trainer name that will be recorded on the release.');
    res.json({ ...factory.approve(req.params.ref, { trainer }, fo), approvedByRole: req.session.role });
  });

  // ---- deployment (Task 6 supplies deploy-office.mjs) ----
  const loadDeployer = async () => {
    const mod = opts.deployModule ?? (existsSync(path.join(REPO, 'deploy-office.mjs')) ? await import(pathToFileURL(path.join(REPO, 'deploy-office.mjs')).href) : null);
    if (!mod || typeof mod.deploy !== 'function') {
      throw new ApiError(503, 'DEPLOY_NOT_INSTALLED', 'The Office deployment tool is not installed in this copy of the Factory.', 'Ask the person who set up the Factory to install deploy-office.mjs, then try again.');
    }
    return mod;
  };
  route('post', '/deploy', authoring, async (req, res) => {
    const m = req.body?.mode;
    if (!DEPLOY_MODES.includes(m)) throw bad(`Choose a deploy mode: ${DEPLOY_MODES.join(', ')}.`, 'Start with "dry-run" to see what would happen.');
    const mod = await loadDeployer();
    if (m === 'dry-run' || m === 'status') return res.json(await mod.deploy({ mode: m }, { root, dataDir }));
    // Real deploys and restarts can take minutes: one keyed job, so a second click or a second Trainer is refused.
    const started = jobs.start({
      kind: 'deploy', owner: req.session.owner, key: 'deploy', progressText: m === 'restart' ? 'Queued. About to restart the Office.' : 'Queued. About to deploy to the Office.',
      work: async (update) => {
        update(m === 'restart' ? 'Restarting the Office. This can take a few minutes.' : 'Deploying to the Office. This can take a few minutes.');
        return mod.deploy({ mode: m }, { root, dataDir });
      }
    });
    if (started.existing) {
      throw new ApiError(409, 'DEPLOY_RUNNING', 'A deployment or restart is already in progress.', 'Wait for it to finish (watch its job progress), then try again if you still need to.');
    }
    accepted(res, started);
  });
  route('get', '/deploy/status', authoring, async (_req, res) => {
    const mod = await loadDeployer();
    res.json(await mod.deploy({ mode: 'status' }, { root, dataDir }));
  });

  route('get', '/jobs/:jobId', authenticated, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || !jobAccess(job, req.session)) {
      throw new ApiError(404, 'JOB_NOT_FOUND', 'That job was not found. The server may have restarted.', 'Open the list of runs or drafts: finished work is saved there.');
    }
    res.json(jobs.view(job));
  });

  // ---- unknown API routes, then the SPA ----
  app.use(BASE, (req, _res, next) => next(new ApiError(404, 'NOT_FOUND', `There is no ${req.method} ${req.path} in this API.`, 'Check the address.')));

  app.use(express.static(clientDist, { index: false, fallthrough: true }));
  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    if (existsSync(path.join(clientDist, 'index.html'))) return res.sendFile(path.join(clientDist, 'index.html'));
    res.status(200).type('html').send('<!doctype html><meta charset="utf-8"><title>SAFI</title><body style="font-family:sans-serif;max-width:40rem;margin:3rem auto"><h1>SAFI is running</h1><p>The web app has not been built yet. In a terminal, run <code>npm run build</code>, then reload this page.</p></body>');
  });

  // ---- errors: always { error: { code, message, hint } } ----
  app.use((err, req, res, _next) => {
    let api = toApiError(err);
    if (!api && err?.type === 'entity.too.large') api = new ApiError(413, 'TOO_LARGE', 'That is too much text to send at once.', 'Shorten the text (the limit is about 200 KB) and try again.');
    if (!api && (err?.type === 'entity.parse.failed' || err instanceof SyntaxError)) api = new ApiError(400, 'BAD_JSON', 'The request was not valid JSON.', 'Reload the page and try again.');
    if (!api) {
      log('error', `${req.id} ${req.method} ${req.path} crashed`, err);
      api = new ApiError(500, 'INTERNAL', 'Something went wrong on our side.', `Try again. If it keeps happening, tell the SAFI Trainer this code: ${req.id}.`);
    }
    res.status(api.status).json(errorBody(api));
  });

  app.locals.mode = mode;
  app.locals.jobs = jobs;
  return app;
}
