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

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/** Poll a background job every 2 s until done or failed. Resolves with the final job; throws ApiError if the job failed. */
export async function pollJob(jobId, onUpdate, signal) {
  for (;;) {
    const job = await get(`/jobs/${jobId}`);
    onUpdate?.(job);
    if (job.status === 'done') return job;
    if (job.status === 'failed') throw new ApiError(200, { error: job.error || { message: 'The job failed.', hint: 'Try again.' } });
    await sleep(2000, signal);
  }
}
