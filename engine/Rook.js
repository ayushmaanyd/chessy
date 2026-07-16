import { Piece } from "./Piece.js";
import { slidingRays } from "./Bishop.js";

export class Rook extends Piece {
  rawMoves(file, rank, board) {
    return slidingRays(file, rank, board, [
      [1, 0], [-1, 0], [0, 1], [0, -1],
    ]);
  }
}
