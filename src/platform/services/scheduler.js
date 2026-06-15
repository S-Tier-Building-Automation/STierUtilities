// scheduler.v1 — the shared job scheduler. Tools register recurring work (poll a
// device, run a sweep) by id + interval; the scheduler runs it, skips overlapping
// runs, and records run counts + the last error per job.
//
// The timer backend is injected so this is deterministically unit-testable: tests
// pass a fake timer and drive jobs with runNow() instead of waiting on wall-clock.

const realTimer = {
  every: (fn, ms) => setInterval(fn, ms),
  cancel: (token) => clearInterval(token),
};

export function createScheduler({ timer = realTimer } = {}) {
  const jobs = new Map(); // id -> { intervalMs, token, runs, lastError, running, tick }

  const api = {
    /**
     * Register (or replace) a recurring job.
     * @param {string} id
     * @param {{intervalMs:number, run:()=>any|Promise<any>, immediate?:boolean}} opts
     */
    register(id, { intervalMs, run, immediate = false }) {
      if (typeof run !== "function") throw new Error("scheduler.register requires a run() function");
      if (!(intervalMs > 0)) throw new Error("scheduler.register requires a positive intervalMs");
      if (jobs.has(id)) api.unregister(id);

      const job = { intervalMs, runs: 0, lastError: null, running: false, token: null };
      job.tick = async () => {
        if (job.running) return; // never overlap a slow job with its next tick
        job.running = true;
        try {
          await run();
          job.runs++;
          job.lastError = null;
        } catch (err) {
          job.lastError = String(err && err.message ? err.message : err);
        } finally {
          job.running = false;
        }
      };
      job.token = timer.every(job.tick, intervalMs);
      jobs.set(id, job);
      if (immediate) job.tick();
      return id;
    },

    unregister(id) {
      const job = jobs.get(id);
      if (!job) return false;
      timer.cancel(job.token);
      jobs.delete(id);
      return true;
    },

    has(id) {
      return jobs.has(id);
    },

    /** Run a registered job's tick once, now (awaitable). */
    async runNow(id) {
      const job = jobs.get(id);
      if (!job) throw new Error(`no such job: ${id}`);
      await job.tick();
    },

    list() {
      return [...jobs.entries()].map(([id, j]) => ({
        id,
        intervalMs: j.intervalMs,
        runs: j.runs,
        lastError: j.lastError,
        running: j.running,
      }));
    },

    stopAll() {
      for (const id of [...jobs.keys()]) api.unregister(id);
    },
  };

  return api;
}
