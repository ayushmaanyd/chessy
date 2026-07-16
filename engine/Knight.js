import { Piece } from "./Piece.js";

const OFFSETS = [
  [2, 1], [2, -1], [-2, 1], [-2, -1],
  [1, 2], [1, -2], [-1, 2], [-1, -2],
];

export class Knight extends Piece {
  rawMoves(file, rank) {
    return OFFSETS.map(([df, dr]) => [file + df, rank + dr]);
  }
}
