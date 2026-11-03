// Tiny in-process job registry for long model calls. Jobs live in memory only; their RESULTS are persisted
// by the Factory (run records, qualification files, drafts), so the UI can recover after a restart.
import { randomUUID } from 'node:crypto';
import { toApiError } from './errors.mjs';

const MAX_RUNNING = 8;
const KEEP_FINISHED = 200;

export class Jobs {
  constructor({ log = () => {} } = {}) {
    this.jobs = new Map();
    this.log = log;
  }

  /** Start work. `key` (optional) de-duplicates: a second start for the same key returns the live job. */
  start({ kind, owner, key, progressText = 'Queued.', work }) {
    if (key) {
      for (const j of this.jobs.values()) if (j.key === key && (j.status === 'queued' || j.status === 'running')) return { job: j, existing: true };
    }
    const running = [...this.jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running').length;
    if (running >= MAX_RUNNING) return { tooBusy: true };
    const job = { jobId: randomUUID(), kind, owner, key, status: 'queued', progressText, createdAt: new Date().toISOString() };
    this.jobs.set(job.jobId, job);
    const update = (text) => { job.progressText = text; };
    setImmediate(async () => {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        job.result = await work(update);
        job.status = 'done';
        job.progressText = 'Finished.';
      } catch (e) {
        const api = toApiError(e);
        if (!api) this.log('error', `job ${job.jobId} (${kind}) crashed`, e);
        job.status = 'failed';
        job.error = api
          ? { code: api.code, message: api.message, hint: api.hint }
          : { code: 'INTERNAL', message: 'Something went wrong on our side while doing this.', hint: 'Try again. If it keeps happening, ask the SAFI Trainer.' };
        job.progressText = 'Stopped.';
      } finally {
        job.finishedAt = new Date().toISOString();
        this.prune();
      }
    });
    return { job, existing: false };
  }

  get(jobId) {
    return this.jobs.get(jobId);
  }

  prune() {
    const done = [...this.jobs.values()].filter((j) => j.finishedAt);
    for (const j of done.slice(0, Math.max(0, done.length - KEEP_FINISHED))) this.jobs.delete(j.jobId);
  }

  view(job) {
    const { jobId, kind, status, progressText, createdAt, startedAt, finishedAt } = job;
    return { jobId, kind, status, progressText, createdAt, startedAt, finishedAt, ...(status === 'done' ? { result: job.result } : {}), ...(status === 'failed' ? { error: job.error } : {}) };
  }
}
