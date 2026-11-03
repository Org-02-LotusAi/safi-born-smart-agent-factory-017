// Thin client for the SAFI Factory API. No secrets live here; the session is an HttpOnly cookie.
const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(status, body) {
    const e = body && body.error ? body.error : {};
    super(e.message || 'Something went wrong talking to the server.');
    this.status = status;
    this.code = e.code || 'UNKNOWN';
    this.hint = e.hint || '';
  }
}

let onSignedOut = () => {};
export function setSignedOutHandler(fn) { onSignedOut = fn; }

export async function api(method, path, body) {
  const headers = {};
  if (method !== 'GET') headers['X-SAFI-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Could not reach the SAFI server.', hint: 'Check that it is running and your connection is working, then try again.' } });
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (err.code === 'NOT_SIGNED_IN') onSignedOut();
    throw err;
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b) => api('POST', p, b ?? {});

const abortError = () => new DOMException('aborted', 'AbortError');
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortError()); return; }
  const onAbort = () => { clearTimeout(t); reject(abortError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** How long to wait overall for each kind of job (ms). */
export const JOB_TIMEOUT = { run: 6 * 60_000, train: 6 * 60_000, qualify: 20 * 60_000, deploy: 10 * 60_000 };

const MAX_POLL_ERRORS = 4;

function pollTimeout() {
  return new ApiError(0, { error: { code: 'POLL_TIMEOUT', message: 'This is taking much longer than expected.', hint: 'It may still be finishing in the background. Wait a few minutes, then reload this page and check again.' } });
}

/**
 * Poll a background job every 2 s until done or failed. Resolves with the final job; throws ApiError if the job failed.
 * Transient errors (network, 5xx, 429) are retried with backoff; definite answers (401, 403, 404 and so on) are thrown at once.
 * After timeoutMs it gives up with code POLL_TIMEOUT (the job may still be running on the server).
 */
export async function pollJob(jobId, onUpdate, signal, timeoutMs = JOB_TIMEOUT.run) {
  const deadline = Date.now() + timeoutMs;
  let errors = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let job;
    try {
      job = await get(`/jobs/${jobId}`);
      errors = 0;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      const transient = e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 429);
      if (!transient || ++errors > MAX_POLL_ERRORS) throw e;
      if (Date.now() > deadline) throw pollTimeout();
      await sleep(Math.min(2000 * 2 ** errors, 15000), signal);
      continue;
    }
    onUpdate?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new ApiError(200, { error: job.error || { message: 'The job failed.', hint: 'Try again.' } });
    if (Date.now() > deadline) throw pollTimeout();
    await sleep(2000, signal);
  }
}
