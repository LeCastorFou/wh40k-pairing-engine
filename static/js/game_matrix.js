const STATE_ORDER = [
  "NONE",     // internal empty
  "GAMBLE",
  "UNKNOWN",
  "EASY",
  "WIN",
  "S_WIN",
  "S_LOOSE",
  "LOOSE",
  "HELP"
];

const STATE_CONFIG = {
  NONE:   { label: "",      bg: "transparent", border: "#444", color: "#f5f5f5" },
  GAMBLE:{ label: "Gamble", bg: "#6a1b9a",     border: "#4a148c", color: "#fff" },
  UNKNOWN:{label: "?",      bg: "#616161",     border: "#424242", color: "#fff" },
  EASY:  { label: "Easy",   bg: "#1b5e20",     border: "#1b5e20", color: "#fff" },
  WIN:   { label: "Win",    bg: "#2e7d32",     border: "#1b5e20", color: "#fff" },
  S_WIN: { label: "S-Win",  bg: "#66bb6a",     border: "#388e3c", color: "#000" },
  S_LOOSE:{label:"S-Loose", bg: "#fff176",     border: "#fdd835", color: "#000" },
  LOOSE: { label: "Loose",  bg: "#fb8c00",     border: "#ef6c00", color: "#000" },
  HELP:  { label: "Help",   bg: "#c62828",     border: "#b71c1c", color: "#fff" }
};

let gPlayers = [];
let gArmies = [];
let gMatrix = {};      // key: "playerId-armyIndex" -> stateKey
let gDirty = false;
let gRosterLocked = false;
let gAllPlayers = [];
let gComment = "";


/* =========================
   Small helpers (supports both roster-snapshot & legacy players)
   ========================= */

function getPlayerId(player) {
  // roster snapshot
  if (typeof player?.player_id === "number") return player.player_id;
  // legacy
  if (typeof player?.id === "number") return player.id;
  return null;
}

function getPlayerName(player) {
  return player?.player_name || player?.name || "Player";
}

function getPlayerDefaultListLabel(player) {
  // roster snapshot: list_text is already the default list (frozen)
  if (typeof player?.list_text === "string" && player.list_text.trim()) {
    const firstLine = player.list_text.split(/\r?\n/).find(l => l.trim().length > 0) || "Default list";
    const trimmed = firstLine.trim();
    return trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;
  }

  // legacy fallback (shouldn't be used once roster snapshot is in place, but safe)
  let defaultLabel = "";
  if (Array.isArray(player?.lists) && typeof player?.default_index === "number") {
    const idx = player.default_index;
    if (idx >= 0 && idx < player.lists.length) {
      const txt = player.lists[idx] || "";
      const firstLine = txt.split(/\r?\n/).find(l => l.trim().length > 0) || "Default list";
      defaultLabel = firstLine.trim();
      if (defaultLabel.length > 40) defaultLabel = defaultLabel.slice(0, 37) + "...";
    }
  }
  return defaultLabel || "No default list";
}


/* =========================
   UI helpers
   ========================= */

function setStatus(text, mode = "normal") {
  const el = document.getElementById("matrix-status");
  el.textContent = text;
  el.className = "status-text";
  if (mode === "unsaved") el.classList.add("unsaved");
  if (mode === "error") el.classList.add("error");
  if (mode === "saved") el.classList.add("saved");
}

function markDirty() {
  gDirty = true;
  document.getElementById("save-matrix-btn").disabled = false;
  setStatus("Changes not saved.", "unsaved");
}

function setCommentUI(comment) {
  gComment = comment || "";
  const input = document.getElementById("matrix-comment-input");
  if (input) input.value = gComment;
}

function applyStateToButton(btn, stateKey) {
  const cfg = STATE_CONFIG[stateKey] || STATE_CONFIG.NONE;
  btn.textContent = cfg.label;
  btn.style.background = cfg.bg;
  btn.style.borderColor = cfg.border;
  btn.style.color = cfg.color;
}

function nextState(current) {
  const idx = STATE_ORDER.indexOf(current);
  if (idx === -1) return "GAMBLE";
  const nextIdx = (idx + 1) % STATE_ORDER.length;
  return STATE_ORDER[nextIdx];
}


/* =========================
   Matrix rendering
   ========================= */

function buildMatrixTable() {
  const table = document.getElementById("matrix-table");
  table.innerHTML = "";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const cornerTh = document.createElement("th");
  cornerTh.className = "sticky-col";
  cornerTh.textContent = "Player \\ Opponent";
  headerRow.appendChild(cornerTh);

  gArmies.forEach((army, idx) => {
    const th = document.createElement("th");
    const headerDiv = document.createElement("div");
    headerDiv.className = "faction-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "faction-name";
    nameSpan.textContent = army.faction || `Army #${idx + 1}`;
    headerDiv.appendChild(nameSpan);

    const tooltip = document.createElement("div");
    tooltip.className = "faction-tooltip";

    const pre = document.createElement("pre");
    pre.textContent = army.list || "No list text.";
    tooltip.appendChild(pre);

    headerDiv.appendChild(tooltip);
    th.appendChild(headerDiv);
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  gPlayers.forEach(player => {
    const pid = getPlayerId(player);
    if (typeof pid !== "number") return; // safety

    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "sticky-col player-name-cell";

    const wrapper = document.createElement("div");

    const nameSpan = document.createElement("div");
    nameSpan.textContent = getPlayerName(player) || `Player ${pid}`;
    nameSpan.style.fontWeight = "500";

    const subSpan = document.createElement("div");
    subSpan.style.fontSize = "0.7rem";
    subSpan.style.color = "#aaa";
    subSpan.textContent = getPlayerDefaultListLabel(player);

    wrapper.appendChild(nameSpan);
    wrapper.appendChild(subSpan);
    nameTd.appendChild(wrapper);
    tr.appendChild(nameTd);

    gArmies.forEach((army, armyIdx) => {
      const td = document.createElement("td");

      const btn = document.createElement("button");
      btn.className = "matrix-cell-btn";
      btn.dataset.playerId = pid;
      btn.dataset.armyIndex = armyIdx;

      const key = `${pid}-${armyIdx}`;
      const stateKey = gMatrix[key] || "NONE";
      btn.dataset.stateKey = stateKey;
      applyStateToButton(btn, stateKey);

      btn.addEventListener("click", () => {
        let current = btn.dataset.stateKey || "NONE";
        const next = nextState(current);
        btn.dataset.stateKey = next;

        const mapKey = `${pid}-${armyIdx}`;
        if (next === "NONE") delete gMatrix[mapKey];
        else gMatrix[mapKey] = next;

        applyStateToButton(btn, next);
        markDirty();
      });

      td.appendChild(btn);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
}


/* =========================
   Roster picker
   ========================= */

function renderRosterPicker() {
  const panel = document.getElementById("roster-panel");
  if (!panel) return;

  panel.style.display = "block";
  panel.innerHTML = "";

  const title = document.createElement("div");
  title.style.letterSpacing = "0.14em";
  title.style.textTransform = "uppercase";
  title.style.marginBottom = "0.6rem";
  title.style.color = "#ddd";
  title.textContent = "Select 8 players for this game (roster will be locked)";
  panel.appendChild(title);

  const hint = document.createElement("div");
  hint.style.color = "#aaa";
  hint.style.fontSize = "0.85rem";
  hint.style.marginBottom = "0.8rem";
  hint.textContent = "You can have more players saved globally. Only 8 are used for this specific game.";
  panel.appendChild(hint);

  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gridTemplateColumns = "repeat(auto-fit, minmax(240px, 1fr))";
  list.style.gap = "0.5rem";
  panel.appendChild(list);

  const selected = new Set();

  function updateCountLabel() {
    count.textContent = `${selected.size} / 8 selected`;
    lockBtn.disabled = selected.size !== 8;
  }

  gAllPlayers.forEach(p => {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "0.5rem";
    row.style.padding = "0.5rem 0.65rem";
    row.style.border = "1px solid rgba(255,255,255,0.10)";
    row.style.borderRadius = "12px";
    row.style.background = "rgba(0,0,0,0.28)";
    row.style.cursor = "pointer";

    const cb = document.createElement("input");
    cb.type = "checkbox";

    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (selected.size >= 8) {
          cb.checked = false;
          alert("You must select exactly 8 players.");
          return;
        }
        selected.add(p.id);
      } else {
        selected.delete(p.id);
      }
      updateCountLabel();
    });

    const name = document.createElement("div");
    name.textContent = p.name || `Player ${p.id}`;
    name.style.fontWeight = "500";

    row.appendChild(cb);
    row.appendChild(name);
    list.appendChild(row);
  });

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "0.75rem";
  actions.style.alignItems = "center";
  actions.style.marginTop = "0.9rem";
  panel.appendChild(actions);

  const count = document.createElement("div");
  count.style.color = "#bbb";
  count.style.fontSize = "0.85rem";
  actions.appendChild(count);

  const lockBtn = document.createElement("button");
  lockBtn.textContent = "Lock roster & start matrix";
  lockBtn.disabled = true;
  lockBtn.addEventListener("click", async () => {
    const ids = Array.from(selected);

    try {
      const res = await fetch(`/api/games/${window.GAME_ID}/roster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ player_ids: ids })
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || "Failed to lock roster.");
        return;
      }

      // reload matrix now that roster is locked
      await loadMatrixData();
    } catch (e) {
      console.error(e);
      alert("Network error while locking roster.");
    }
  });
  actions.appendChild(lockBtn);

  updateCountLabel();
}


/* =========================
   Data load / save
   ========================= */

async function loadMatrixData() {
  setStatus("Loading matrix...");
  document.getElementById("save-matrix-btn").disabled = true;

  const res = await fetch(`/api/games/${window.GAME_ID}/matrix`);
  if (!res.ok) {
    setStatus("Error loading matrix.", "error");
    throw new Error("Failed to load matrix");
  }

  const data = await res.json();
  const game = data.game;
  setCommentUI(game?.comment || "");

  gRosterLocked = !!data.roster_locked;
  gAllPlayers = data.all_players || [];

  document.getElementById("opponent-name-label").textContent =
    `Opponent: ${game.opponent_name || "Unknown"}`;
  document.getElementById("army-count-label").textContent =
    `${(game.armies || []).length} codex`;

  // If roster not locked -> show picker, hide matrix
  if (!gRosterLocked) {
    gPlayers = [];
    gArmies = game.armies || [];
    gMatrix = {};

    const table = document.getElementById("matrix-table");
    if (table) table.innerHTML = "";

    setStatus("Roster not locked for this game. Select 8 players first.", "unsaved");
    renderRosterPicker();
    return;
  }

  // Roster locked -> normal matrix load
  const rosterPanel = document.getElementById("roster-panel");
  if (rosterPanel) {
    rosterPanel.style.display = "none";
    rosterPanel.innerHTML = "";
  }

  gPlayers = data.players || [];     // now roster snapshot objects
  gArmies = game.armies || [];
  gMatrix = data.matrix || {};

  buildMatrixTable();
  gDirty = false;
  setStatus("Matrix loaded. Click cells to cycle through states.");
}

async function saveMatrix() {
  if (!gDirty) return;

  const btn = document.getElementById("save-matrix-btn");
  btn.disabled = true;
  setStatus("Saving...");

  const commentInput = document.getElementById("matrix-comment-input");
  if (commentInput) gComment = commentInput.value || "";

  const entries = Object.entries(gMatrix).map(([key, value]) => {
    const [playerIdStr, armyIndexStr] = key.split("-");
    return {
      player_id: parseInt(playerIdStr, 10),
      army_index: parseInt(armyIndexStr, 10),
      value
    };
  });

  try {
    const res = await fetch(`/api/games/${window.GAME_ID}/matrix`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries, comment: gComment })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(data);
      setStatus(data.error || "Error saving matrix.", "error");
      btn.disabled = false;
      return;
    }

    gDirty = false;
    setCommentUI(gComment);
    setStatus("Matrix saved. The data-vault is pleased.", "saved");
  } catch (err) {
    console.error(err);
    setStatus("Network or server error while saving.", "error");
    btn.disabled = false;
  }
}


/* =========================
   Init
   ========================= */

document.addEventListener("DOMContentLoaded", async () => {
  const saveBtn = document.getElementById("save-matrix-btn");
  saveBtn.addEventListener("click", saveMatrix);

  try {
    await loadMatrixData();
  } catch (err) {
    console.error(err);
  }
});


/* =========================
   Optimize
   ========================= */

async function optimizePairing() {
  const box = document.getElementById("optimize-results");
  box.innerHTML = "Computing optimal pairing...";

  const res = await fetch(`/api/games/${window.GAME_ID}/optimize`);
  const data = await res.json();

  if (!res.ok) {
    box.innerHTML = `<div style="color:#ff8a80;">${data.error || "Optimization failed."}</div>`;
    return;
  }

  const sols = data.solutions || [];
  if (!sols.length) {
    box.innerHTML = `<div style="color:#bbb;">No solutions.</div>`;
    return;
  }

  // Render best solution + alternatives
  let html = "";
  sols.forEach((sol, idx) => {
    html += `
      <div style="border:1px solid rgba(255,255,255,0.08); border-radius:12px; padding:0.8rem; margin-bottom:0.8rem; background:rgba(0,0,0,0.35);">
        <div style="display:flex; justify-content:space-between; gap:1rem; align-items:center;">
          <div style="letter-spacing:.14em; text-transform:uppercase; color:#ddd;">
            ${idx === 0 ? "Best pairing" : `Alternative #${idx}`}
          </div>
          <div style="color:#e74c3c; font-weight:600;">
            Total: ${sol.total_expected} pts
          </div>
        </div>

        <div style="margin-top:.6rem;">
          ${sol.pairings.map(p => `
            <div style="display:flex; justify-content:space-between; gap:1rem; padding:.35rem .2rem; border-bottom:1px solid rgba(255,255,255,0.06);">
              <div>${p.player_name} → <strong>${p.faction}</strong></div>
              <div style="opacity:.85;">${p.state} (${p.expected})</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  });

  box.innerHTML = html;
}




document.addEventListener("DOMContentLoaded", async () => {

  // SAVE MATRIX
  const saveBtn = document.getElementById("save-matrix-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveMatrix);

  const commentInput = document.getElementById("matrix-comment-input");
  if (commentInput) {
    commentInput.addEventListener("input", () => {
      gComment = commentInput.value || "";
      markDirty();
    });
  }

  // OPTIMIZE
  const optBtn = document.getElementById("optimize-btn");
  if (optBtn) optBtn.addEventListener("click", optimizePairing);

  // 📄 NEW — download PDF
  const dlBtn = document.getElementById("download-lists-btn");
  if (dlBtn) {
    dlBtn.addEventListener("click", () => {
      if (typeof window.GAME_ID === "undefined") {
        console.error("GAME_ID missing");
        return;
      }
      window.location.href = `/api/games/${window.GAME_ID}/lists_pdf`;
    });
  }

  // Load the matrix normally
  try {
    await loadMatrixData();
  } 
  catch(err) {
    console.error(err);
  }
});
