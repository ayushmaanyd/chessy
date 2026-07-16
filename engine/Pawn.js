import { Piece } from "./Piece.js";

export class Pawn extends Piece {
  rawMoves(file, rank, board) {
    const dir = this.color === "w" ? 1 : -1; // white moves up (rank+), black down
    const startRank = this.color === "w" ? 1 : 6;
    const moves = [];

    // Single push — only if square is empty.
    if (!board.at(file, rank + dir)) {
      moves.push([file, rank + dir]);
      // Double push from starting rank.
      if (rank === startRank && !board.at(file, rank + 2 * dir)) {
        moves.push([file, rank + 2 * dir]);
      }
    }

    // Diagonal captures — only if an enemy piece occupies the square.
    for (const df of [-1, 1]) {
      const occ = board.at(file + df, rank + dir);
      if (occ && occ.color !== this.color) {
        moves.push([file + df, rank + dir]);
      }
    }

    return moves;
  }
}
