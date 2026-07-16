import { Piece } from "./Piece.js";

export class Bishop extends Piece {
  rawMoves(file, rank, board) {
    return slidingRays(file, rank, board, [
      [1, 1], [1, -1], [-1, 1], [-1, -1],
    ]);
  }
}

// Shared helper for sliding piece rays.
export function slidingRays(file, rank, board, directions) {
  const moves = [];
  for (const [df, dr] of directions) {
    let f = file + df;
    let r = rank + dr;
    while (f >= 0 && f <= 7 && r >= 0 && r <= 7) {
      const occ = board.at(f, r);
      if (occ) {
        moves.push([f, r]); // capture square included; legalMoves will filter own pieces
        break;
      }
      moves.push([f, r]);
      f += df;
      r += dr;
    }
  }
  return moves;
}
