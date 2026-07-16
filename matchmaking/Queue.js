import { EventEmitter } from "node:events";

/**
 * Thread-safe matchmaking queue.
 *
 * Node.js is single-threaded: the event loop processes one callback at a time,
 * so #queue mutations are atomic — no locks needed. All enqueue/dequeue/tryMatch
 * operations complete synchronously within a single event loop tick.
 */
export class MatchmakingQueue extends EventEmitter {
  #queue = []; // [{ ws, name, session }]

  enqueue(ws, name, session) {
    // Idempotent — reject duplicate sessions (e.g. reconnect during queue wait).
    if (this.#queue.some((p) => p.session === session)) return;
    this.#queue.push({ ws, name, session });
    // Notify player of their queue position.
    ws.send(JSON.stringify({ t: "queued", position: this.#queue.length }));
    this.#tryMatch();
  }

  dequeue(session) {
    this.#queue = this.#queue.filter((p) => p.session !== session);
  }

  get size() {
    return this.#queue.length;
  }

  #tryMatch() {
    if (this.#queue.length < 2) return;
    const [a, b] = this.#queue.splice(0, 2);
    // Emit synchronously — server.js listener creates the game and notifies both players.
    this.emit("match", a, b);
  }
}
