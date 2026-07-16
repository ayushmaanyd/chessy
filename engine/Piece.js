export class Piece {
  constructor(color) {
    if (new.target === Piece) throw new Error("Piece is abstract");
    this.color = color; // 'w' | 'b'
  }

  // Returns [[file, rank], ...] squares this piece can reach from (file, rank),
  // considering board geometry and friendly pieces but NOT check.
  // Subclasses must override.
  rawMoves(file, rank, board) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name}.rawMoves() not implemented`);
  }

  // Filters rawMoves to legal squares (within bounds, not occupied by own piece).
  legalMoves(file, rank, board) {
    return this.rawMoves(file, rank, board).filter(([f, r]) => {
      if (f < 0 || f > 7 || r < 0 || r > 7) return false;
      const occ = board.at(f, r);
      return !occ || occ.color !== this.color;
    });
  }

  isValidMove(fromFile, fromRank, toFile, toRank, board) {
    return this.legalMoves(fromFile, fromRank, board)
      .some(([f, r]) => f === toFile && r === toRank);
  }
}
