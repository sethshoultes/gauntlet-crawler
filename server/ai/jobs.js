// In-memory job store for the async AI level-generation API (server/index.js POST/GET
// /api/levels/generate*). Generation via Claude can take up to ~100s, and Cloudflare (which sits
// in front of production) kills any proxied request that runs longer than 100s -- so the
// generate endpoint starts the work in the background and hands the caller a job id to poll
// instead of holding the connection open. See README.md "Level Builder and AI generator".
import crypto from 'node:crypto';

const MAX_JOBS = 200;
const EXPIRE_MS = 10 * 60_000; // finished jobs are kept 10 minutes so a slow poller still finds them

const jobs = new Map(); // id -> { owner, status, result, error, createdAt, finishedAt }

/**
 * Start a background job. `owner` scopes who is allowed to poll it (a user id string or an IP-derived
 * key -- whatever identity the caller used for rate limiting). `runner` is an async function producing
 * the eventual result payload.
 * @returns {string} jobId
 */
export class JobStoreFullError extends Error {
  constructor() { super('The level generator is busy; please try again in a minute'); this.status = 503; }
}

export function startJob(owner, runner) {
  // Cap concurrent entries: evict the oldest finished job to make room; if every job is still
  // pending there is nothing safe to evict, so refuse (the API maps this to a 503) rather than
  // letting the map grow past MAX_JOBS while slow generations pile up.
  if (jobs.size >= MAX_JOBS) {
    const oldestDone = [...jobs.entries()]
      .filter(([, j]) => j.status !== 'pending')
      .sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
    if (!oldestDone) throw new JobStoreFullError();
    jobs.delete(oldestDone[0]);
  }
  const id = crypto.randomBytes(12).toString('hex');
  const job = { owner, status: 'pending', result: null, error: null, createdAt: Date.now(), finishedAt: null };
  jobs.set(id, job);
  Promise.resolve().then(runner).then(
    (result) => { job.status = 'done'; job.result = result; job.finishedAt = Date.now(); },
    (err) => { job.status = 'error'; job.error = err?.message || 'Generation failed'; job.finishedAt = Date.now(); },
  );
  return id;
}

/**
 * Look up a job for a given owner. Returns undefined if the job doesn't exist or belongs to
 * someone else (the caller should treat that as a 404, same as "no such job").
 */
export function getJob(id, owner) {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return undefined;
  return job;
}

// Sweep jobs finished more than EXPIRE_MS ago. unref()'d so it never keeps the process alive on
// its own (mirrors the rate-limit bucket sweep in server/index.js).
export const sweepInterval = setInterval(() => {
  const cutoff = Date.now() - EXPIRE_MS;
  for (const [id, job] of jobs) if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
}, 60_000).unref();

// Test-only escape hatches (no server restart needed between test files).
export function _clear() { jobs.clear(); }
export function _size() { return jobs.size; }
