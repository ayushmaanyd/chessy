import { Piece } from "./Piece.js";

const OFFSETS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export class King extends Piece {
  rawMoves(file, rank) {
    return OFFSETS.map(([df, dr]) => [file + df, rank + dr]);
  }
}
