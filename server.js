import express from "express";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { saveCompletedGame, listRecentGames, getOverallStats } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const app = express();

// Serve the chess.js browser build so the client can compute legal moves locally.
app.get("/vendor/chess.js", (_req, res) => {
  res.type("application/javascript");
  res.sendFile(join(__dirname, "node_modules/chess.js/dist/esm/chess.js"));
});
app.use(express.static(join(__dirname, "public")));

// Single-page app: a game URL like /AB12 also serves the same page.
app.get(/^\/[A-Za-z0-9]{4,8}$/, (_req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/**
 * In-memory game store. No database / Redis needed — games live as long as the
 * server runs (and a bit after the last player leaves, for reconnects).
 * @type {Map<string, Game>}
 */
const games = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no easily-confused chars
function makeCode() {
  let code;
  do {
    code = Array.from(
      { length: 4 },
      () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join("");
  } while (games.has(code));
  return code;
}

function createGame(code) {
  /** @typedef {{session:string,name:string,ws:WebSocket|null}} Seat */
  const game = {
    code,
    chess: new Chess(),
    /** @type {{w: Seat|null, b: Seat|null}} */
    players: { w: null, b: null },
    spectators: new Set(),
    result: null, // null | { winner: "w"|"b"|"d", reason: string }
    createdAt: Date.now(),
    reapTimer: null,
    persisted: false, // true once this game's outcome has been written to SQLite
  };
  games.set(code, game);
  return game;
}

function allSockets(game) {
  const out = [];
  if (game.players.w?.ws) out.push(game.players.w.ws);
  if (game.players.b?.ws) out.push(game.players.b.ws);
  for (const ws of game.spectators) out.push(ws);
  return out;
}

function statusOf(game) {
  const c = game.chess;
  if (game.result) {
    return { over: true, winner: game.result.winner, reason: game.result.reason };
  }
  if (c.isCheckmate()) {
    return { over: true, winner: c.turn() === "w" ? "b" : "w", reason: "checkmate" };
  }
  if (c.isStalemate()) return { over: true, winner: "d", reason: "stalemate" };
  if (c.isInsufficientMaterial())
    return { over: true, winner: "d", reason: "insufficient material" };
  if (c.isThreefoldRepetition())
    return { over: true, winner: "d", reason: "threefold repetition" };
  if (c.isDraw()) return { over: true, winner: "d", reason: "50-move rule" };
  return { over: false, winner: null, reason: null };
}

function snapshot(game) {
  const verbose = game.chess.history({ verbose: true });
  const last = verbose[verbose.length - 1];
  return {
    fen: game.chess.fen(),
    turn: game.chess.turn(),
    inCheck: game.chess.inCheck(),
    history: game.chess.history(), // SAN strings
    lastMove: last ? { from: last.from, to: last.to } : null,
    names: {
      w: game.players.w?.name ?? null,
      b: game.players.b?.name ?? null,
    },
    connected: {
      w: !!game.players.w?.ws,
      b: !!game.players.b?.ws,
    },
    status: statusOf(game),
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState(game) {
  const base = snapshot(game);
  for (const ws of allSockets(game)) {
    send(ws, { t: "state", ...base, you: ws._role });
  }
}

function broadcast(game, msg, exceptWs = null) {
  for (const ws of allSockets(game)) {
    if (ws !== exceptWs) send(ws, msg);
  }
}

// Writes a finished game to SQLite exactly once (guarded by game.persisted).
function persistIfDone(game) {
  if (game.persisted) return;
  const status = statusOf(game);
  if (!status.over) return;
  game.persisted = true;
  saveCompletedGame({
    code: game.code,
    whiteName: game.players.w?.name ?? null,
    blackName: game.players.b?.name ?? null,
    winner: status.winner,
    reason: status.reason,
    moves: game.chess.history(),
    startedAt: game.createdAt,
  });
}

function scheduleReap(game) {
  if (game.reapTimer) return;
  // If everyone is gone for 10 minutes, drop the game to free memory.
  game.reapTimer = setTimeout(() => {
    if (allSockets(game).length === 0) games.delete(game.code);
  }, 10 * 60 * 1000);
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const code = (url.searchParams.get("code") || "").toUpperCase();
  const session = url.searchParams.get("session") || "";
  const name = (url.searchParams.get("name") || "Anonymous").slice(0, 24);

  if (!code || !session) {
    send(ws, { t: "error", message: "Missing game code or session." });
    ws.close();
    return;
  }

  const game = games.get(code) || createGame(code);
  if (game.reapTimer) {
    clearTimeout(game.reapTimer);
    game.reapTimer = null;
  }

  // Reconnect: if this session already holds a seat, reattach to it.
  let role;
  if (game.players.w?.session === session) {
    role = "w";
    game.players.w.ws = ws;
    game.players.w.name = name;
  } else if (game.players.b?.session === session) {
    role = "b";
    game.players.b.ws = ws;
    game.players.b.name = name;
  } else if (!game.players.w && !game.players.b) {
    // First player: random color, fair start.
    role = Math.random() < 0.5 ? "w" : "b";
    game.players[role] = { session, name, ws };
  } else if (!game.players.w) {
    role = "w";
    game.players.w = { session, name, ws };
  } else if (!game.players.b) {
    role = "b";
    game.players.b = { session, name, ws };
  } else {
    role = "spectator";
    game.spectators.add(ws);
  }

  ws._role = role;
  ws._game = game;
  ws._session = session;

  send(ws, { t: "joined", code, you: role });
  broadcastState(game);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, game, msg);
  });

  ws.on("close", () => {
    if (game.players.w?.ws === ws) game.players.w.ws = null;
    else if (game.players.b?.ws === ws) game.players.b.ws = null;
    else game.spectators.delete(ws);
    broadcastState(game);
    if (allSockets(game).length === 0) scheduleReap(game);
  });
});

function handleMessage(ws, game, msg) {
  const role = ws._role;

  switch (msg.t) {
    case "move": {
      if (role !== "w" && role !== "b") return; // spectators can't move
      if (game.result) return; // game already decided
      if (game.chess.turn() !== role) return; // not your turn
      let move;
      try {
        move = game.chess.move({
          from: msg.from,
          to: msg.to,
          promotion: msg.promotion || "q",
        });
      } catch {
        move = null;
      }
      if (!move) {
        // Illegal — resync this client to the authoritative state.
        send(ws, { t: "state", ...snapshot(game), you: role });
        return;
      }
      broadcastState(game);
      persistIfDone(game);
      break;
    }

    case "resign": {
      if (role !== "w" && role !== "b") return;
      if (game.result || statusOf(game).over) return;
      game.result = { winner: role === "w" ? "b" : "w", reason: "resignation" };
      broadcastState(game);
      persistIfDone(game);
      break;
    }

    case "rematch": {
      if (role !== "w" && role !== "b") return;
      if (!statusOf(game).over) return;
      game[`rematch_${role}`] = true;
      if (game.rematch_w && game.rematch_b) {
        // Reset board and swap colors so both get a turn with each side.
        game.chess = new Chess();
        game.result = null;
        game.rematch_w = false;
        game.rematch_b = false;
        game.createdAt = Date.now();
        game.persisted = false;
        const w = game.players.w;
        const b = game.players.b;
        game.players.w = b;
        game.players.b = w;
        if (game.players.w?.ws) game.players.w.ws._role = "w";
        if (game.players.b?.ws) game.players.b.ws._role = "b";
        broadcast(game, { t: "rematch-start" });
        broadcastState(game);
      } else {
        broadcast(game, { t: "rematch-offer", from: role });
      }
      break;
    }

    case "chat": {
      const text = String(msg.text || "").slice(0, 300).trim();
      if (!text) return;
      const fromName =
        role === "w"
          ? game.players.w?.name
          : role === "b"
            ? game.players.b?.name
            : "Spectator";
      broadcast(game, { t: "chat", from: fromName || "?", role, text });
      break;
    }
  }
}

// Lightweight health/info endpoint.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, games: games.size });
});

// Create-a-game endpoint returns a fresh code.
app.get("/api/new", (_req, res) => {
  res.json({ code: makeCode() });
});

// Match history, read from SQLite — populated as games finish (see persistIfDone).
app.get("/api/history", (_req, res) => {
  res.json({ games: listRecentGames(25), stats: getOverallStats() });
});

server.listen(PORT, () => {
  console.log(`\n  ♟  Chessy running:  http://localhost:${PORT}\n`);
});
