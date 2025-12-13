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
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "sticky-col player-name-cell";

    const wrapper = document.createElement("div");

    const nameSpan = document.createElement("div");
    nameSpan.textContent = player.name || `Player ${player.id}`;
    nameSpan.style.fontWeight = "500";

    const subSpan = document.createElement("div");
    subSpan.style.fontSize = "0.7rem";
    subSpan.style.color = "#aaa";

    let defaultLabel = "";
    if (Array.isArray(player.lists) && typeof player.default_index === "number") {
        const idx = player.default_index;
        if (idx >= 0 && idx < player.lists.length) {
        const txt = player.lists[idx] || "";
        const firstLine = txt.split(/\r?\n/).find(l => l.trim().length > 0) || "Default list";
        defaultLabel = firstLine.trim();
        if (defaultLabel.length > 40) {
            defaultLabel = defaultLabel.slice(0, 37) + "...";
        }
        }
    }
    if (!defaultLabel) {
        defaultLabel = "No default list";
    }
    subSpan.textContent = defaultLabel;

    wrapper.appendChild(nameSpan);
    wrapper.appendChild(subSpan);
    nameTd.appendChild(wrapper);

    tr.appendChild(nameTd);


    gArmies.forEach((army, armyIdx) => {
      const td = document.createElement("td");

      const btn = document.createElement("button");
      btn.className = "matrix-cell-btn";
      btn.dataset.playerId = player.id;
      btn.dataset.armyIndex = armyIdx;

      const key = `${player.id}-${armyIdx}`;
      const stateKey = gMatrix[key] || "NONE";
      btn.dataset.stateKey = stateKey;
      applyStateToButton(btn, stateKey);

      btn.addEventListener("click", () => {
        let current = btn.dataset.stateKey || "NONE";
        const next = nextState(current);
        btn.dataset.stateKey = next;
        const mapKey = `${player.id}-${armyIdx}`;
        if (next === "NONE") {
          delete gMatrix[mapKey];
        } else {
          gMatrix[mapKey] = next;
        }
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
  gPlayers = data.players || [];
  gArmies = game.armies || [];
  gMatrix = data.matrix || {};

  document.getElementById("opponent-name-label").textContent =
    `Opponent: ${game.opponent_name || "Unknown"}`;
  document.getElementById("army-count-label").textContent =
    `${gArmies.length} codex`;

  buildMatrixTable();
  gDirty = false;
  setStatus("Matrix loaded. Click cells to cycle through states.");
}

async function saveMatrix() {
  if (!gDirty) return;
  const btn = document.getElementById("save-matrix-btn");
  btn.disabled = true;
  setStatus("Saving...");

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
      body: JSON.stringify({ entries })
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(data);
      setStatus(data.error || "Error saving matrix.", "error");
      btn.disabled = false;
      return;
    }

    gDirty = false;
    setStatus("Matrix saved. The data-vault is pleased.", "saved");
  } catch (err) {
    console.error(err);
    setStatus("Network or server error while saving.", "error");
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const saveBtn = document.getElementById("save-matrix-btn");
  saveBtn.addEventListener("click", saveMatrix);

  try {
    await loadMatrixData();
  } catch (err) {
    console.error(err);
  }
});
