import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir);

export const db = new Database(join(dataDir, "chessy.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    white_name TEXT,
    black_name TEXT,
    winner TEXT,
    reason TEXT,
    moves TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO games (code, white_name, black_name, winner, reason, moves, started_at, ended_at)
  VALUES (@code, @whiteName, @blackName, @winner, @reason, @moves, @startedAt, @endedAt)
`);

export function saveCompletedGame({ code, whiteName, blackName, winner, reason, moves, startedAt }) {
  insertStmt.run({
    code,
    whiteName: whiteName ?? null,
    blackName: blackName ?? null,
    winner,
    reason,
    moves: JSON.stringify(moves),
    startedAt,
    endedAt: Date.now(),
  });
}

const listStmt = db.prepare(`SELECT * FROM games ORDER BY id DESC LIMIT ?`);

export function listRecentGames(limit = 25) {
  return listStmt.all(limit).map(rowToGame);
}

const statsStmt = db.prepare(`
  SELECT
    COUNT(*) AS totalGames,
    SUM(CASE WHEN winner = 'd' THEN 1 ELSE 0 END) AS draws
  FROM games
`);

export function getOverallStats() {
  return statsStmt.get();
}

function rowToGame(row) {
  return {
    id: row.id,
    code: row.code,
    whiteName: row.white_name,
    blackName: row.black_name,
    winner: row.winner,
    reason: row.reason,
    moves: JSON.parse(row.moves),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}
