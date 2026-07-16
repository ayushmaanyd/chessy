import { parentPort } from "node:worker_threads";
import { Board } from "./Board.js";

// Parse algebraic notation (e.g. "e4") → [file, rank] indices.
function parseAlg(sq) {
  return [sq.charCodeAt(0) - 97, parseInt(sq[1], 10) - 1]; // 'a'=0, '1'=0
}

parentPort.on("message", ({ id, fen, from, to }) => {
  let valid = false;
  try {
    const board = Board.fromFen(fen);
    const [ff, fr] = parseAlg(from);
    const [tf, tr] = parseAlg(to);
    const cell = board.at(ff, fr);
    if (cell) {
      valid = cell.piece.isValidMove(ff, fr, tf, tr, board);
    }
  } catch {
    valid = false;
  }
  parentPort.postMessage({ id, valid });
});
