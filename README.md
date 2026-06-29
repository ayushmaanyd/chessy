# Chessy — play chess with a friend over a link

Create a game, share the 4-character link, and play live chess in your browser.
No sign-up, no separate database server to install.

## Run it

```bash
npm install
npm start
```

Then open **http://localhost:8080**.

- Click **Create a game** — you get a link like `http://localhost:8080/AB12`.
- Send that link to a friend. The first person to open it joins as your opponent.
- Make moves by clicking a piece and a target square, or by dragging.

For development with auto-reload: `npm run dev`.

## Playing with a friend on another computer

`localhost` only works on your own machine. To let a friend connect:

- **Same Wi-Fi / LAN:** share `http://<your-local-ip>:8080/<code>` (find your IP with
  `ipconfig`). Allow Node through the Windows firewall if prompted.
- **Over the internet:** expose port 8080 with a tunnel, e.g.
  `npx localtunnel --port 8080` or `ngrok http 8080`, and share the URL it gives you.

## Tech stack

A single Node process serves everything — chosen for zero-config reliability on any OS.

- **Backend:** Express (static hosting + tiny REST) and [`ws`](https://github.com/websockets/ws)
  for realtime play. [`chess.js`](https://github.com/jhlywa/chess.js) is the
  authoritative move validator on the server.
- **Frontend:** plain HTML/CSS/JS (ES modules). The same `chess.js` build is served
  to the browser for instant legal-move highlighting; the server stays the source of truth.
- **Live state:** in-memory `Map` of in-progress games. Games survive disconnects
  (reconnect by session) and are reaped 10 minutes after everyone leaves.
- **Persistence:** [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) —
  a real relational DBMS. Every finished game (checkmate, resignation, draw) is
  written to a `games` table in `data/chessy.db` with both players' names, the
  result/reason, the full SAN move list, and timestamps. Browse it at `/history`,
  or query it directly with `sqlite3 data/chessy.db`.

### Features

- Shareable game links + 4-char join codes
- Random fair color assignment, reconnect keeps your seat
- Legal-move hints, last-move and check highlighting, drag-and-drop, promotion picker
- Move list (SAN), live chat, resign, and rematch (with color swap)
- Spectators can watch once both seats are filled
- **Match history** at `/history` — every finished game is persisted to SQLite
  and listed with players, result, and the full move list

### Layout

```
server.js          # Express + WebSocket game server
db.js               # SQLite (better-sqlite3) — schema + persistence helpers
data/                # chessy.db lives here (gitignored, created on first run)
public/             # index.html, style.css, app.js, piece SVGs
```

> The original `server/` (uWebSockets.js + Redis) and `web/` (Next.js) folders are
> kept for reference but are not used by this app.
