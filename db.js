import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "data");
if (!existsSync(dataDir)) mkdirSync(dataDir);

export const db = new Database(join(dataDir, "chessy.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  -- Legacy table kept so existing DB files are not broken.
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
  );

  -- Normalized schema (v2) ─────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    UNIQUE NOT NULL,
    elo        INTEGER NOT NULL DEFAULT 1200,
    games      INTEGER NOT NULL DEFAULT 0,
    wins       INTEGER NOT NULL DEFAULT 0,
    losses     INTEGER NOT NULL DEFAULT 0,
    draws      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS matches (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT    NOT NULL,
    white_id   INTEGER REFERENCES users(id),
    black_id   INTEGER REFERENCES users(id),
    winner     TEXT,
    reason     TEXT,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );

  CREATE TABLE IF NOT EXISTS match_moves (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id   INTEGER NOT NULL REFERENCES matches(id),
    move_num   INTEGER NOT NULL,
    move_san   TEXT    NOT NULL,
    fen_after  TEXT    NOT NULL,
    played_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_matches_white ON matches(white_id);
  CREATE INDEX IF NOT EXISTS idx_matches_black ON matches(black_id);
  CREATE INDEX IF NOT EXISTS idx_match_moves_match ON match_moves(match_id);
`);

// ── Prepared statements ───────────────────────────────────────────────────────

const upsertUser = db.prepare(
  `INSERT OR IGNORE INTO users (name, elo, games, wins, losses, draws, created_at)
   VALUES (?, 1200, 0, 0, 0, 0, ?)`
);

const getUserByName = db.prepare(`SELECT * FROM users WHERE name = ?`);

const insertMatch = db.prepare(
  `INSERT INTO matches (code, white_id, black_id, winner, reason, started_at, ended_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const insertMove = db.prepare(
  `INSERT INTO match_moves (match_id, move_num, move_san, fen_after, played_at)
   VALUES (?, ?, ?, ?, ?)`
);

const updateUserStats = db.prepare(
  `UPDATE users SET elo=?, games=games+1, wins=wins+?, losses=losses+?, draws=draws+? WHERE id=?`
);

// ── Elo computation ───────────────────────────────────────────────────────────

function computeElo(eloW, eloB, winner) {
  const K = 32;
  const expectedW = 1 / (1 + Math.pow(10, (eloB - eloW) / 400));
  const expectedB = 1 - expectedW;
  const actualW = winner === "w" ? 1 : winner === "d" ? 0.5 : 0;
  const actualB = 1 - actualW;
  return {
    newEloW: Math.round(eloW + K * (actualW - expectedW)),
    newEloB: Math.round(eloB + K * (actualB - expectedB)),
  };
}

// ── ACID transaction ──────────────────────────────────────────────────────────

const saveMatchTxn = db.transaction(
  ({ code, whiteName, blackName, winner, reason, moves, fens, startedAt }) => {
    const now = Date.now();

    // 1. Upsert both players into users table.
    if (whiteName) upsertUser.run(whiteName, now);
    if (blackName) upsertUser.run(blackName, now);

    const wUser = whiteName ? getUserByName.get(whiteName) : null;
    const bUser = blackName ? getUserByName.get(blackName) : null;

    // 2. Compute Elo deltas (only if both players are known).
    let newEloW = wUser?.elo ?? 1200;
    let newEloB = bUser?.elo ?? 1200;
    if (wUser && bUser) {
      const elos = computeElo(wUser.elo, bUser.elo, winner);
      newEloW = elos.newEloW;
      newEloB = elos.newEloB;
    }

    // 3. Insert match record.
    const matchId = insertMatch.run(
      code,
      wUser?.id ?? null,
      bUser?.id ?? null,
      winner,
      reason,
      startedAt,
      now
    ).lastInsertRowid;

    // 4. Bulk-insert move history with FEN snapshots.
    for (let i = 0; i < moves.length; i++) {
      insertMove.run(matchId, i + 1, moves[i], fens[i] ?? "", now);
    }

    // 5. Update Elo + win/loss/draw tallies atomically.
    if (wUser) {
      updateUserStats.run(
        newEloW,
        winner === "w" ? 1 : 0,
        winner === "b" ? 1 : 0,
        winner === "d" ? 1 : 0,
        wUser.id
      );
    }
    if (bUser) {
      updateUserStats.run(
        newEloB,
        winner === "b" ? 1 : 0,
        winner === "w" ? 1 : 0,
        winner === "d" ? 1 : 0,
        bUser.id
      );
    }
  }
);

export function saveCompletedGame(opts) {
  saveMatchTxn(opts);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

const listMatchesStmt = db.prepare(`
  SELECT
    m.id, m.code, m.winner, m.reason, m.started_at, m.ended_at,
    wu.name AS white_name, bu.name AS black_name,
    wu.elo  AS white_elo,  bu.elo  AS black_elo
  FROM matches m
  LEFT JOIN users wu ON wu.id = m.white_id
  LEFT JOIN users bu ON bu.id = m.black_id
  ORDER BY m.id DESC
  LIMIT ?
`);

export function listRecentGames(limit = 25) {
  return listMatchesStmt.all(limit).map((row) => ({
    id: row.id,
    code: row.code,
    whiteName: row.white_name,
    blackName: row.black_name,
    winner: row.winner,
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    // include moves lazily only when needed
    moves: getMovesForMatch(row.id),
  }));
}

const movesForMatchStmt = db.prepare(
  `SELECT move_san FROM match_moves WHERE match_id = ? ORDER BY move_num`
);

function getMovesForMatch(matchId) {
  return movesForMatchStmt.all(matchId).map((r) => r.move_san);
}

const overallStatsStmt = db.prepare(`
  SELECT
    COUNT(*) AS totalGames,
    COALESCE(SUM(CASE WHEN winner = 'd' THEN 1 ELSE 0 END), 0) AS draws
  FROM matches
`);

export function getOverallStats() {
  return overallStatsStmt.get();
}

const playerStatsStmt = db.prepare(
  `SELECT games, wins, losses, draws, elo FROM users WHERE name = ?`
);

export function getPlayerStats(name) {
  return (
    playerStatsStmt.get(name) ?? { games: 0, wins: 0, losses: 0, draws: 0, elo: 1200 }
  );
}

const leaderboardStmt = db.prepare(
  `SELECT name, elo, games, wins, losses, draws FROM users ORDER BY elo DESC LIMIT ?`
);

export function getLeaderboard(limit = 10) {
  return leaderboardStmt.all(limit);
}
