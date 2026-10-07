/**
 * Server-sent events hub for index progress and live-session events. Clients
 * get a state snapshot on connect, every broadcast event afterwards, and a
 * comment heartbeat every 15 s so proxies and browsers keep the stream open.
 * Subscribers are capped; a broken socket is dropped on its first error.
 *
 * Event types on the stream (all JSON objects with a `type`):
 *   state / start / progress / done / removed / cleared   index passes (index/writer.mjs); a pass started by the
 *                                                          live watcher carries `live: true` so the UI does not reload
 *                                                          (its `done` is recorded as manifest.lastLivePass, never lastPass)
 *   live       { runId, vendor, at, requests, peak, last?: { index, total, at, model }, parseMs, file? }
 *              a live transcript was re-parsed (index/watch.mjs); sticky per runId so a new subscriber learns
 *              which runs are live right now
 *   live-idle  { runId, at }   the transcript stopped changing (clears the sticky `live` event)
 *
 * `broadcast(event, { sticky })` keeps the event under `sticky` and replays it
 * to later subscribers; `forget(sticky)` drops it.
 */
import { BASE_HEADERS } from "./http.mjs";

export const MAX_SSE_CLIENTS = 16;
export const LIVE_EVENT_TYPES = Object.freeze(["live", "live-idle"]);

export function createSseHub({ heartbeatMs = 15_000, maxClients = MAX_SSE_CLIENTS } = {}) {
  const clients = new Set();
  const sticky = new Map();
  let timer = null;

  function write(response, chunk) {
    try {
      response.write(chunk);
    } catch {
      clients.delete(response);
    }
  }

  function tick() {
    for (const client of clients) write(client, ": ping\n\n");
  }

  function ensureTimer() {
    if (timer || !clients.size) return;
    timer = setInterval(tick, heartbeatMs);
    timer.unref?.();
  }

  return {
    get size() { return clients.size; },
    get maxClients() { return maxClients; },
    /** Sticky events currently held (replayed to new subscribers), in insertion order. */
    get stickyEvents() { return [...sticky.values()]; },
    /** Returns false (and answers 503) when the subscriber cap is reached. */
    subscribe(request, response, initial = []) {
      if (clients.size >= maxClients) {
        response.writeHead(503, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "retry-after": "5" });
        response.end("Too many event-stream subscribers.");
        return false;
      }
      response.writeHead(200, {
        ...BASE_HEADERS,
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      request.socket?.setNoDelay?.(true);
      request.socket?.setTimeout?.(0);
      response.write("retry: 2000\n\n");
      for (const event of initial) write(response, `data: ${JSON.stringify(event)}\n\n`);
      for (const event of sticky.values()) write(response, `data: ${JSON.stringify(event)}\n\n`);
      clients.add(response);
      ensureTimer();
      const drop = () => {
        clients.delete(response);
        if (!clients.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
      request.on("close", drop);
      request.on("error", drop);
      response.on("close", drop);
      response.on("error", drop);
      return true;
    },
    /** Sends `event` to every subscriber; with `sticky` it is also replayed to future subscribers until `forget(sticky)`. */
    broadcast(event, { sticky: key } = {}) {
      if (typeof key === "string") sticky.set(key, event);
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of clients) write(client, payload);
    },
    forget(key) {
      return sticky.delete(key);
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      for (const client of clients) {
        try { client.end(); } catch {}
      }
      clients.clear();
      sticky.clear();
    },
  };
}
