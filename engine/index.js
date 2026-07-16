import { Worker } from "node:worker_threads";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Thread pool — one worker per CPU (minus one for the event loop).
export class EnginePool {
  #workers = [];
  #pending = new Map(); // id → resolve
  #counter = 0;

  constructor(size = Math.max(1, os.cpus().length - 1)) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(join(__dirname, "worker.js"));
      w.on("message", ({ id, valid }) => {
        const resolve = this.#pending.get(id);
        if (resolve) {
          this.#pending.delete(id);
          resolve(valid);
        }
      });
      w.on("error", (err) => console.error("[EnginePool] worker error:", err));
      this.#workers.push(w);
    }
  }

  // Returns a Promise<boolean> — true if the move is geometrically reachable.
  validate(fen, from, to) {
    return new Promise((resolve) => {
      const id = this.#counter++;
      const worker = this.#workers[id % this.#workers.length];
      this.#pending.set(id, resolve);
      worker.postMessage({ id, fen, from, to });
    });
  }

  terminate() {
    for (const w of this.#workers) w.terminate();
  }
}

export { Piece } from "./Piece.js";
export { Pawn } from "./Pawn.js";
export { Knight } from "./Knight.js";
export { Bishop } from "./Bishop.js";
export { Rook } from "./Rook.js";
export { Queen } from "./Queen.js";
export { King } from "./King.js";
export { Board } from "./Board.js";
