/**
 * Minimal worker_threads pool. Each task is posted to an idle worker and
 * resolves with the worker's reply. A crashed worker rejects its in-flight
 * task with `WorkerFailure` and is respawned (up to `maxCrashes` times per
 * pool); after that the pool is marked broken so the caller can fall back to
 * in-process work. An `AbortSignal` drains the queue and terminates workers.
 * `run(task, context)` posts an optional per-task context (the persistent live
 * pool in index/writer.mjs reuses one worker across passes); `unref: true`
 * lets the process exit while such a pool is idle.
 */
import { Worker } from "node:worker_threads";

export class WorkerFailure extends Error {
  constructor(message, { aborted = false } = {}) {
    super(message);
    this.name = "WorkerFailure";
    this.aborted = aborted;
  }
}

export function createPool({ size = 4, workerUrl, workerData = {}, signal, maxCrashes = 3, onWarning, unref = false } = {}) {
  const idle = [];
  const workers = [];
  const queue = [];
  const pending = new Map(); // worker -> { resolve, reject, task }
  let broken = false;
  let crashes = 0;
  let closed = false;
  let nextId = 1;

  function rejectQueue(reason) {
    while (queue.length) queue.shift().reject(reason);
  }

  function spawn() {
    const worker = new Worker(workerUrl, { workerData });
    // A persistent (live) pool must not keep the process alive on its own.
    if (unref) worker.unref();
    worker.on("message", (message) => {
      if (message?.type === "warnings" && Array.isArray(message.warnings)) {
        for (const warning of message.warnings) onWarning?.(String(warning));
        return;
      }
      const job = pending.get(worker);
      if (!job) return;
      pending.delete(worker);
      if (message?.ok) job.resolve(message.entry);
      else job.reject(new WorkerFailure(message?.error ?? "worker returned an invalid reply"));
      idle.push(worker);
      drain();
    });
    const fail = (reason) => {
      const job = pending.get(worker);
      pending.delete(worker);
      const at = workers.indexOf(worker);
      if (at >= 0) workers.splice(at, 1);
      const idleAt = idle.indexOf(worker);
      if (idleAt >= 0) idle.splice(idleAt, 1);
      if (closed) { job?.reject(new WorkerFailure("worker pool closed", { aborted: true })); return; }
      crashes += 1;
      if (job) job.reject(new WorkerFailure(String(reason?.message ?? reason ?? "worker exited")));
      if (crashes > maxCrashes || !workers.length && crashes > maxCrashes) {
        broken = true;
        rejectQueue(new WorkerFailure("worker pool is broken"));
        return;
      }
      // Replace the crashed worker so one poison file does not degrade the whole pass.
      try { spawn(); drain(); } catch { broken = true; rejectQueue(new WorkerFailure("worker pool is broken")); }
    };
    worker.on("error", fail);
    worker.on("exit", (code) => { if (code !== 0) fail(new Error(`worker exited with code ${code}`)); });
    workers.push(worker);
    idle.push(worker);
  }

  function drain() {
    while (idle.length && queue.length) {
      const worker = idle.pop();
      const job = queue.shift();
      pending.set(worker, job);
      worker.postMessage({ id: nextId++, task: job.task, context: job.context });
    }
  }

  async function close() {
    closed = true;
    broken = true;
    rejectQueue(new WorkerFailure("worker pool closed", { aborted: true }));
    await Promise.all(workers.splice(0).map((worker) => worker.terminate().catch(() => {})));
    idle.length = 0;
  }

  try {
    for (let index = 0; index < size; index += 1) spawn();
  } catch (error) {
    broken = true;
    for (const worker of workers) worker.terminate().catch(() => {});
    throw new WorkerFailure(error?.message ?? "could not start workers");
  }

  const onAbort = () => { close().catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    get broken() { return broken; },
    get closed() { return closed; },
    get crashes() { return crashes; },
    /** Runs `task`; `context` (optional) overrides the pool's workerData for this task (per-pass context on a persistent pool). */
    run(task, context) {
      if (closed) return Promise.reject(new WorkerFailure("worker pool closed", { aborted: true }));
      if (broken) return Promise.reject(new WorkerFailure("worker pool is broken"));
      return new Promise((resolve, reject) => {
        queue.push({ task, context, resolve, reject });
        drain();
      });
    },
    async close() {
      signal?.removeEventListener?.("abort", onAbort);
      await close();
    },
  };
}
