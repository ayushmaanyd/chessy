import express from "express";
import { WebSocketServer } from "ws";
import { Chess } from "chess.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { saveCompletedGame, listRecentGames, getOverallStats, getPlayerStats, getLeaderboard, db } from "./db.js";
import { EnginePool } from "./engine/index.js";
import { MatchmakingQueue } from "./matchmaking/Queue.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// Worker thread pool for OOP engine pre-validation (CPU-bound, off main thread).
const enginePool = new EnginePool();

// Matchmaking queue — pairs players who click "Quick match".
const queue = new MatchmakingQueue();
queue.on("match", (a, b) => {
  const code = makeCode();
  const game = createGame(code);
  // Randomly assign colors.
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  game.players.w = { session: white.session, name: white.name, ws: white.ws };
  game.players.b = { session: black.session, name: black.name, ws: black.ws };
  white.ws._role = "w";
  black.ws._role = "b";
  white.ws._game = game;
  black.ws._game = game;
  white.ws._session = white.session;
  black.ws._session = black.session;
  white.ws.send(JSON.stringify({ t: "joined", code, you: "w" }));
  black.ws.send(JSON.stringify({ t: "joined", code, you: "b" }));
  broadcastState(game);
});

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

// ── Networks: per-IP rate limiter ─────────────────────────────────────────────
// Limits WebSocket connections to 20 per IP per minute.
const rateLimits = new Map(); // ip → { count, resetAt }

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count > 20;
}

// ── Networks: WebSocket heartbeat ─────────────────────────────────────────────
// Pings all clients every 30 s. Clients that don't pong within that window
// are terminated (stale TCP connections that didn't fire a close event).
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

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
    fens: [],         // FEN snapshot after every move (for match_moves table)
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
    fens: game.fens,
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
  // Networks: heartbeat tracking — mark alive; reset on every pong.
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  // Networks: rate limiting — drop abusive IPs before any game logic runs.
  const ip = req.socket.remoteAddress ?? "unknown";
  if (isRateLimited(ip)) {
    ws.close(1008, "Rate limit exceeded");
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const mode = url.searchParams.get("mode") || "";
  const session = url.searchParams.get("session") || "";
  const name = (url.searchParams.get("name") || "Anonymous").slice(0, 24);

  // Matchmaking path — player is queued until a match is found.
  if (mode === "queue") {
    if (!session) { ws.close(); return; }
    ws._role = "queued";
    queue.enqueue(ws, name, session);
    ws.on("close", () => queue.dequeue(session));
    return;
  }

  const code = (url.searchParams.get("code") || "").toUpperCase();

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
    // handleMessage is async (uses engine worker thread for move pre-validation).
    handleMessage(ws, game, msg).catch((err) =>
      console.error("[ws] handleMessage error:", err)
    );
  });

  ws.on("close", () => {
    if (game.players.w?.ws === ws) game.players.w.ws = null;
    else if (game.players.b?.ws === ws) game.players.b.ws = null;
    else game.spectators.delete(ws);
    broadcastState(game);
    if (allSockets(game).length === 0) scheduleReap(game);
  });
});

async function handleMessage(ws, game, msg) {
  const role = ws._role;

  switch (msg.t) {
    case "move": {
      if (role !== "w" && role !== "b") return; // spectators can't move
      if (game.result) return; // game already decided
      if (game.chess.turn() !== role) return; // not your turn

      // OOP engine pre-validation runs in a Worker thread (non-blocking).
      // This is a fast geometric check; chess.js remains the final authority.
      const geometryOk = await enginePool.validate(game.chess.fen(), msg.from, msg.to);
      if (!geometryOk) {
        send(ws, { t: "state", ...snapshot(game), you: role });
        return;
      }

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
        // Illegal by chess.js rules (e.g. leaves king in check) — resync client.
        send(ws, { t: "state", ...snapshot(game), you: role });
        return;
      }
      game.fens.push(game.chess.fen());
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
        game.fens = [];
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

// Per-player win/loss/Elo stats.
app.get("/api/stats", (req, res) => {
  const name = String(req.query.name || "").trim().slice(0, 24);
  if (!name) return res.json({ games: 0, wins: 0, losses: 0, draws: 0, elo: 1200 });
  res.json(getPlayerStats(name));
});

// Leaderboard — top players by Elo.
app.get("/api/leaderboard", (_req, res) => {
  res.json({ players: getLeaderboard(10) });
});

server.listen(PORT, () => {
  console.log(`\n  ♟  Chessy running:  http://localhost:${PORT}\n`);
});

// ── OS: Graceful shutdown ─────────────────────────────────────────────────────
// SIGTERM is sent by Docker/systemd/Heroku on stop. SIGINT is Ctrl-C.
// We stop accepting new connections, notify all WebSocket clients, flush the
// SQLite WAL to disk, and exit cleanly instead of being force-killed.
function gracefulShutdown(signal) {
  console.log(`\n  [${signal}] Graceful shutdown — draining ${wss.clients.size} connections…`);
  clearInterval(heartbeatInterval);
  enginePool.terminate();
  wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
  server.close(() => {
    db.close();
    console.log("  Shutdown complete.");
    process.exit(0);
  });
  // Force-exit after 5 s if connections don't close cleanly.
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
