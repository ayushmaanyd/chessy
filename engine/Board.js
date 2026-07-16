import { Pawn } from "./Pawn.js";
import { Knight } from "./Knight.js";
import { Bishop } from "./Bishop.js";
import { Rook } from "./Rook.js";
import { Queen } from "./Queen.js";
import { King } from "./King.js";

// Piece encoding for Uint8Array:  0 = empty
// Bits 3-0: type index  1=P 2=N 3=B 4=R 5=Q 6=K
// Bit 4:    color        0=w  1=b
const TYPE_MAP = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const IDX_TO_CLASS = [null, Pawn, Knight, Bishop, Rook, Queen, King];

function encode(fenChar) {
  const lower = fenChar.toLowerCase();
  const typeIdx = TYPE_MAP[lower];
  if (!typeIdx) return 0;
  const colorBit = fenChar === lower ? 0x10 : 0; // black = lowercase
  return typeIdx | colorBit;
}

export class Board {
  constructor() {
    this._data = new Uint8Array(64); // 0 = empty
  }

  static fromFen(fen) {
    const board = new Board();
    const placement = fen.split(" ")[0];
    let rank = 7; // FEN rank 8 → index 7
    let file = 0;
    for (const ch of placement) {
      if (ch === "/") {
        rank--;
        file = 0;
      } else if (ch >= "1" && ch <= "8") {
        file += parseInt(ch, 10);
      } else {
        board._data[rank * 8 + file] = encode(ch);
        file++;
      }
    }
    return board;
  }

  // Returns { color: 'w'|'b', piece: Piece } or null.
  at(file, rank) {
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    const byte = this._data[rank * 8 + file];
    if (!byte) return null;
    const typeIdx = byte & 0x0f;
    const color = byte & 0x10 ? "b" : "w";
    const PieceClass = IDX_TO_CLASS[typeIdx];
    if (!PieceClass) return null;
    return { color, piece: new PieceClass(color) };
  }
}
