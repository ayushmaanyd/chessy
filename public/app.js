import { Chess } from "/vendor/chess.js";

// ---- piece asset mapping (matches files in /public/pieces) ----
const PIECE_IDX = { p: 0, n: 1, b: 2, r: 3, q: 4, k: 5 };
const pieceUrl = (type, color) => `/pieces/${PIECE_IDX[type]}${color}.svg`;

// ---- persistent identity (so reconnects keep your color) ----
// sessionStorage is per-tab (unlike localStorage), so opening the game in two
// tabs of the same browser — e.g. to test both sides — gives each tab its own
// seat instead of both fighting over one.
const session =
  sessionStorage.getItem("chessy-session") ||
  (() => {
    const s = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("chessy-session", s);
    return s;
  })();
let myName = localStorage.getItem("chessy-name") || "";

// ---- routing ----
const path = location.pathname.replace(/^\/+|\/+$/g, "");
const isGameRoute = /^[A-Za-z0-9]{4}$/.test(path);

const $ = (id) => document.getElementById(id);

if (path.toLowerCase() === "history") initHistory();
else if (isGameRoute) initGame(path.toUpperCase());
else initHome();

// =====================================================================
// HOME
// =====================================================================
function initHome() {
  $("home").classList.remove("hidden");
  const nameInput = $("home-name");
  nameInput.value = myName;

  $("create-btn").addEventListener("click", async () => {
    saveName(nameInput.value);
    const res = await fetch("/api/new");
    const { code } = await res.json();
    location.href = "/" + code;
  });

  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveName(nameInput.value);
    const code = $("join-code").value.trim().toUpperCase();
    if (/^[A-Z0-9]{4}$/.test(code)) location.href = "/" + code;
    else toast("Enter a 4-character code");
  });
}

function saveName(v) {
  myName = (v || "").trim() || "Anonymous";
  localStorage.setItem("chessy-name", myName);
}

// =====================================================================
// MATCH HISTORY — reads completed games persisted to SQLite by the server.
// =====================================================================
async function initHistory() {
  $("history-page").classList.remove("hidden");
  const listEl = $("history-list");
  const statsEl = $("history-stats");

  let data;
  try {
    const res = await fetch("/api/history");
    data = await res.json();
  } catch {
    listEl.textContent = "Couldn't load match history.";
    return;
  }

  const { games, stats } = data;
  statsEl.textContent = `${stats.totalGames} game${stats.totalGames === 1 ? "" : "s"} played · ${stats.draws} draw${stats.draws === 1 ? "" : "s"}`;

  // Personal stats card
  if (myName && myName !== "Anonymous") {
    try {
      const res = await fetch(`/api/stats?name=${encodeURIComponent(myName)}`);
      const ps = await res.json();
      if (ps.games > 0) {
        const card = document.createElement("div");
        card.className = "player-stats";
        card.innerHTML = `
          <span class="ps-name">${escapeHtml(myName)}</span>
          <span class="ps-stat win">${ps.wins}W</span>
          <span class="ps-stat loss">${ps.losses}L</span>
          <span class="ps-stat draw">${ps.draws}D</span>
          <span class="ps-total">${ps.games} game${ps.games === 1 ? "" : "s"}</span>
        `;
        listEl.before(card);
      }
    } catch { /* non-fatal */ }
  }

  if (games.length === 0) {
    listEl.innerHTML = `<p class="muted">No completed games yet — finish a game and it'll show up here.</p>`;
    return;
  }

  listEl.innerHTML = "";
  for (const g of games) {
    const row = document.createElement("div");
    row.className = "history-row";

    const resultLabel =
      g.winner === "d"
        ? "Draw"
        : `${g.winner === "w" ? g.whiteName || "White" : g.blackName || "Black"} won`;

    const date = new Date(g.endedAt).toLocaleString();

    row.innerHTML = `
      <div class="history-row-top">
        <span class="history-code">${escapeHtml(g.code)}</span>
        <span class="history-players">${escapeHtml(g.whiteName || "White")} vs ${escapeHtml(g.blackName || "Black")}</span>
        <span class="history-result">${escapeHtml(resultLabel)} <span class="muted">(${escapeHtml(g.reason)})</span></span>
        <span class="history-date muted">${date}</span>
        <button class="btn small toggle-moves">Moves (${g.moves.length})</button>
      </div>
      <div class="history-moves hidden"></div>
    `;

    const toggleBtn = row.querySelector(".toggle-moves");
    const movesEl = row.querySelector(".history-moves");
    toggleBtn.addEventListener("click", () => {
      movesEl.classList.toggle("hidden");
      if (!movesEl.dataset.filled) {
        movesEl.dataset.filled = "1";
        let text = "";
        for (let i = 0; i < g.moves.length; i += 2) {
          text += `${i / 2 + 1}. ${g.moves[i]} ${g.moves[i + 1] || ""}  `;
        }
        movesEl.textContent = text.trim();
      }
    });

    listEl.appendChild(row);
  }
}

// =====================================================================
// GAME
// =====================================================================
function initGame(code) {
  $("game").classList.remove("hidden");
  if (!myName) {
    myName = prompt("Your name?")?.trim() || "Anonymous";
    localStorage.setItem("chessy-name", myName);
  }

  // Local mirror of the board, used only for rendering + legal-move hints.
  const chess = new Chess();
  const board = $("board");

  let you = "spectator"; // "w" | "b" | "spectator"
  let orientation = "w"; // bottom side
  let selected = null; // square name currently selected
  let legalTargets = new Map(); // targetSquare -> move object
  let lastMove = null;
  let serverStatus = { over: false };
  let ws = null;
  let pendingPromotion = null; // { from, to }

  const squares = new Map(); // "e4" -> element
  buildBoard();

  // ---- share UI ----
  const shareUrl = location.origin + "/" + code;
  $("share-link").value = shareUrl;
  $("share-code").textContent = code;
  $("copy-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast("Link copied — send it to your friend!");
    } catch {
      $("share-link").select();
      toast("Press Ctrl+C to copy");
    }
  });

  $("resign-btn").addEventListener("click", () => {
    if (confirm("Resign this game?")) sendMsg({ t: "resign" });
  });
  $("rematch-btn").addEventListener("click", () => sendMsg({ t: "rematch" }));
  $("modal-rematch").addEventListener("click", () => {
    sendMsg({ t: "rematch" });
    toast("Rematch requested…");
  });

  $("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chat-input");
    const text = input.value.trim();
    if (text) sendMsg({ t: "chat", text });
    input.value = "";
  });

  connect();

  // ----------------------------------------------------------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws?code=${code}&session=${session}&name=${encodeURIComponent(
      myName
    )}`;
    ws = new WebSocket(url);

    ws.addEventListener("open", () => setConn(true));
    ws.addEventListener("close", () => {
      setConn(false);
      // Auto-reconnect; the server reattaches us to our seat by session.
      setTimeout(connect, 1500);
    });
    ws.addEventListener("message", (e) => onServerMessage(JSON.parse(e.data)));
  }

  function sendMsg(m) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  function onServerMessage(msg) {
    switch (msg.t) {
      case "joined":
        you = msg.you;
        orientation = you === "b" ? "b" : "w";
        buildBoard(); // re-orient if needed
        break;
      case "state":
        applyState(msg);
        break;
      case "chat":
        addChat(msg);
        break;
      case "rematch-offer":
        if (msg.from !== you) toast("Opponent wants a rematch — click Rematch");
        break;
      case "rematch-start":
        $("modal").classList.add("hidden");
        toast("New game! Colors swapped.");
        break;
      case "error":
        toast(msg.message || "Error");
        break;
    }
  }

  function applyState(s) {
    chess.load(s.fen);
    lastMove = s.lastMove;
    serverStatus = s.status;
    you = s.you;
    if (you === "b" && orientation !== "b") {
      orientation = "b";
      buildBoard();
    }
    selected = null;
    legalTargets.clear();
    render();
    updatePanels(s);
  }

  // ----------------------------------------------------------------
  // Board construction & rendering
  // ----------------------------------------------------------------
  function buildBoard() {
    board.innerHTML = "";
    squares.clear();
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ranks = [8, 7, 6, 5, 4, 3, 2, 1];
    const fileOrder = orientation === "w" ? files : [...files].reverse();
    const rankOrder = orientation === "w" ? ranks : [...ranks].reverse();

    for (const r of rankOrder) {
      for (const f of fileOrder) {
        const name = f + r;
        const fileIdx = files.indexOf(f);
        const isLight = (fileIdx + r) % 2 === 1;
        const sq = document.createElement("div");
        sq.className = "sq " + (isLight ? "light" : "dark");
        sq.dataset.square = name;

        // coordinate labels on the edges
        if (f === fileOrder[0]) {
          const c = document.createElement("span");
          c.className = "coord rank";
          c.textContent = r;
          sq.appendChild(c);
        }
        if (r === rankOrder[rankOrder.length - 1]) {
          const c = document.createElement("span");
          c.className = "coord file";
          c.textContent = f;
          sq.appendChild(c);
        }

        // All input (tap-to-select, tap-to-move, and drag) is handled through
        // pointer events so there's a single source of truth — no separate click
        // listener that could double-handle a tap.
        sq.addEventListener("pointerdown", (e) => onPointerDown(e, name));
        squares.set(name, sq);
        board.appendChild(sq);
      }
    }
    render();
  }

  function render() {
    const grid = chess.board(); // 8x8 from rank 8 -> 1
    // clear
    for (const sq of squares.values()) {
      sq.classList.remove("sel", "last", "check", "capture", "draggable");
      const p = sq.querySelector(".piece");
      if (p) p.remove();
      const h = sq.querySelector(".hint");
      if (h) h.remove();
    }

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const cell = grid[row][col];
        if (!cell) continue;
        const name = "abcdefgh"[col] + (8 - row);
        const sq = squares.get(name);
        const piece = document.createElement("div");
        piece.className = "piece";
        piece.style.backgroundImage = `url(${pieceUrl(cell.type, cell.color)})`;
        if (cell.color === you && !serverStatus.over) sq.classList.add("draggable");
        sq.appendChild(piece);
      }
    }

    // last move highlight
    if (lastMove) {
      squares.get(lastMove.from)?.classList.add("last");
      squares.get(lastMove.to)?.classList.add("last");
    }

    // check highlight
    if (chess.inCheck()) {
      const turn = chess.turn();
      for (const [name, sq] of squares) {
        const cell = chess.get(name);
        if (cell && cell.type === "k" && cell.color === turn) sq.classList.add("check");
      }
    }

    // selection + hints
    if (selected) {
      squares.get(selected)?.classList.add("sel");
      for (const [target, mv] of legalTargets) {
        const sq = squares.get(target);
        if (!sq) continue;
        if (mv.captured || mv.flags.includes("e")) sq.classList.add("capture");
        const hint = document.createElement("div");
        hint.className = "hint";
        sq.appendChild(hint);
      }
    }
  }

  // ----------------------------------------------------------------
  // Interaction
  // ----------------------------------------------------------------
  function myTurn() {
    return !serverStatus.over && (you === "w" || you === "b") && chess.turn() === you;
  }

  function selectSquare(name) {
    const piece = chess.get(name);
    if (!myTurn() || !piece || piece.color !== you) return;
    selected = name;
    legalTargets.clear();
    for (const mv of chess.moves({ square: name, verbose: true })) {
      legalTargets.set(mv.to, mv);
    }
    render();
  }

  function deselect() {
    selected = null;
    legalTargets.clear();
    render();
  }

  function tryMove(from, to) {
    const mv = legalTargets.get(to);
    selected = null;
    if (!mv) {
      legalTargets.clear();
      render();
      return;
    }
    // promotion?
    if (mv.flags.includes("p")) {
      legalTargets.clear();
      showPromotion(from, to);
      return;
    }
    doMove(from, to);
  }

  function doMove(from, to, promotion) {
    // optimistic local apply for snappy feel; server will confirm via state
    try {
      const applied = chess.move({ from, to, promotion: promotion || undefined });
      if (applied) {
        lastMove = { from, to };
        selected = null;
        legalTargets.clear();
        render();
      }
    } catch {
      /* ignore — server is source of truth */
    }
    sendMsg({ t: "move", from, to, promotion });
  }

  // ---- drag and drop ----
  // A press becomes a *drag* only once the pointer moves past a small threshold;
  // otherwise it's a plain *click* (handled by onSquareClick) and no ghost piece
  // is ever created. Exactly one ghost can exist, and it is always cleaned up.
  const DRAG_THRESHOLD = 5; // px
  let drag = null; // { from, startX, startY, ghost|null, pieceEl, size }

  // Belt-and-suspenders: nuke any orphaned ghost clones that somehow survived.
  function clearGhosts() {
    document.querySelectorAll(".piece.dragging").forEach((el) => el.remove());
  }

  function onPointerDown(e, name) {
    if (e.button !== undefined && e.button !== 0) return;
    if (drag) endDrag(); // clean up any prior interaction first
    const piece = chess.get(name);
    if (!myTurn() || !piece || piece.color !== you) return;
    e.preventDefault();
    selectSquare(name);

    const rect = board.getBoundingClientRect();
    drag = {
      from: name,
      startX: e.clientX,
      startY: e.clientY,
      ghost: null,
      pieceEl: squares.get(name)?.querySelector(".piece") || null,
      size: rect.width / 8,
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  function liftPiece(e) {
    clearGhosts();
    const ghost = drag.pieceEl ? drag.pieceEl.cloneNode(true) : document.createElement("div");
    ghost.className = "piece dragging";
    ghost.style.setProperty("--sqsize", drag.size + "px");
    document.body.appendChild(ghost);
    if (drag.pieceEl) drag.pieceEl.style.opacity = "0.25";
    drag.ghost = ghost;
    moveGhost(e);
  }

  function moveGhost(e) {
    if (!drag?.ghost) return;
    drag.ghost.style.left = e.clientX - drag.size / 2 + "px";
    drag.ghost.style.top = e.clientY - drag.size / 2 + "px";
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.ghost) {
      const moved = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
      if (moved < DRAG_THRESHOLD) return; // still just a click, no piece lifted yet
      liftPiece(e);
    }
    moveGhost(e);
  }

  // Tears down listeners and removes the ghost. Returns whether a real drag occurred.
  function endDrag() {
    if (!drag) return false;
    const wasDragging = !!drag.ghost;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    if (drag.pieceEl) drag.pieceEl.style.opacity = "";
    clearGhosts();
    drag = null;
    return wasDragging;
  }

  function onPointerUp(e) {
    if (!drag) return;
    const from = drag.from;
    const wasDragging = endDrag();
    if (!wasDragging) return; // plain click — onSquareClick handles selection/move

    const target = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest?.(".sq"))
      .find(Boolean);

    if (target && target.dataset.square && legalTargets.has(target.dataset.square)) {
      tryMove(from, target.dataset.square);
    } else {
      render(); // keep selection/hints visible
    }
  }

  function onPointerCancel() {
    endDrag();
    render();
  }

  // ---- promotion picker ----
  function showPromotion(from, to) {
    pendingPromotion = { from, to };
    const overlay = $("overlay");
    overlay.innerHTML = "";
    overlay.classList.remove("hidden");
    overlay.style.position = "absolute";
    overlay.style.inset = "0";
    overlay.style.display = "grid";
    overlay.style.placeItems = "center";
    overlay.style.background = "rgba(8,11,17,0.75)";
    overlay.style.zIndex = "20";

    const tray = document.createElement("div");
    tray.style.display = "flex";
    tray.style.gap = "8px";
    tray.style.background = "var(--panel)";
    tray.style.border = "1px solid var(--line)";
    tray.style.borderRadius = "12px";
    tray.style.padding = "10px";

    for (const t of ["q", "r", "b", "n"]) {
      const b = document.createElement("button");
      b.className = "btn";
      b.style.width = "56px";
      b.style.height = "56px";
      b.style.backgroundImage = `url(${pieceUrl(t, you)})`;
      b.style.backgroundSize = "80%";
      b.style.backgroundRepeat = "no-repeat";
      b.style.backgroundPosition = "center";
      b.addEventListener("click", () => {
        overlay.classList.add("hidden");
        overlay.innerHTML = "";
        doMove(pendingPromotion.from, pendingPromotion.to, t);
        pendingPromotion = null;
      });
      tray.appendChild(b);
    }
    overlay.appendChild(tray);
  }

  // ----------------------------------------------------------------
  // Panels (players, turn, moves, modal)
  // ----------------------------------------------------------------
  function updatePanels(s) {
    const topColor = orientation === "w" ? "b" : "w";
    const botColor = orientation === "w" ? "w" : "b";
    setStrip("player-top", topColor, s);
    setStrip("player-bottom", botColor, s);

    // share panel: hide once both seats are filled
    const bothHere = s.names.w && s.names.b;
    $("share").classList.toggle("hidden", !!bothHere);

    // move list
    const moves = s.history;
    const ol = $("moves");
    ol.innerHTML = "";
    for (let i = 0; i < moves.length; i += 2) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="num">${i / 2 + 1}.</span><span>${moves[i]}</span><span>${
        moves[i + 1] || ""
      }</span>`;
      ol.appendChild(li);
    }
    ol.scrollTop = ol.scrollHeight;

    // turn + buttons
    const resignBtn = $("resign-btn");
    const rematchBtn = $("rematch-btn");
    const turnEl = $("turn");

    if (s.status.over) {
      resignBtn.disabled = true;
      rematchBtn.classList.toggle("hidden", you === "spectator");
      turnEl.textContent = resultText(s.status);
      showModal(s.status);
    } else {
      $("modal").classList.add("hidden");
      rematchBtn.classList.add("hidden");
      resignBtn.disabled = you === "spectator";
      if (you === "spectator") {
        turnEl.textContent = `${s.turn === "w" ? "White" : "Black"} to move (spectating)`;
      } else if (!bothHere) {
        turnEl.textContent = "Waiting for opponent…";
      } else {
        turnEl.textContent = myTurn() ? "Your move" : "Opponent's move";
      }
    }
  }

  function setStrip(elId, color, s) {
    const el = $(elId);
    const name = s.names[color];
    const connected = s.connected[color];
    const isYou = color === you;
    el.querySelector(".pname").textContent =
      (name || "Waiting…") + (isYou ? " (you)" : "");
    el.querySelector(".ptag").textContent = color === "w" ? "White" : "Black";
    el.classList.toggle("live", !!connected);
    el.classList.toggle("turn-now", !s.status.over && s.turn === color);
  }

  function resultText(st) {
    if (st.winner === "d") return `Draw — ${st.reason}`;
    const side = st.winner === "w" ? "White" : "Black";
    const youWon = st.winner === you;
    return `${side} wins by ${st.reason}` + (you !== "spectator" ? (youWon ? " — you win! 🎉" : " — you lose") : "");
  }

  function showModal(st) {
    const modal = $("modal");
    let title;
    if (st.winner === "d") title = "Draw";
    else if (you === "spectator") title = (st.winner === "w" ? "White" : "Black") + " wins";
    else title = st.winner === you ? "You win! 🎉" : "You lose";
    $("modal-title").textContent = title;
    $("modal-sub").textContent = resultText(st);
    $("modal-rematch").classList.toggle("hidden", you === "spectator");
    modal.classList.remove("hidden");
  }

  function addChat(msg) {
    const log = $("chat-log");
    const div = document.createElement("div");
    div.className = "msg" + (msg.role === you ? " me" : "");
    div.innerHTML = `<b>${escapeHtml(msg.from)}:</b> ${escapeHtml(msg.text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
}

// =====================================================================
// helpers
// =====================================================================
function setConn(online) {
  const el = $("conn");
  if (!el) return;
  el.textContent = online ? "online" : "reconnecting…";
  el.classList.toggle("online", online);
}

let toastTimer;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
