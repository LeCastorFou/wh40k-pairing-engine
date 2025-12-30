/* =========================
   Fight page main logic
   ========================= */

// Matchup states -> visual config (same as matrix page)
const STATE_CONFIG = {
  NONE:    { label: "",       bg: "transparent", border: "#444",    color: "#f5f5f5" },
  GAMBLE:  { label: "Gamble", bg: "#6a1b9a",     border: "#4a148c", color: "#fff" },
  UNKNOWN: { label: "?",      bg: "#616161",     border: "#424242", color: "#fff" },
  EASY:    { label: "Easy",   bg: "#1b5e20",     border: "#1b5e20", color: "#fff" },
  WIN:     { label: "Win",    bg: "#2e7d32",     border: "#1b5e20", color: "#fff" },
  S_WIN:   { label: "S-Win",  bg: "#66bb6a",     border: "#388e3c", color: "#000" },
  S_LOOSE: { label: "S-Loose",bg: "#fff176",     border: "#fdd835", color: "#000" },
  LOOSE:   { label: "Loose",  bg: "#fb8c00",     border: "#ef6c00", color: "#000" },
  HELP:    { label: "Help",   bg: "#c62828",     border: "#b71c1c", color: "#fff" }
};

// Expected score mapping (midpoints of your ranges)
const STATE_TO_EXPECTED = {
  HELP: 3.0,       // <5
  LOOSE: 6.5,      // 5–8
  S_LOOSE: 9.0,    // 8–10
  S_WIN: 11.0,     // 10–12
  WIN: 13.5,       // 12–15
  EASY: 16.0,      // 15+
  UNKNOWN: 10.0,   // uncertain
  GAMBLE: 10.0,    // uncertain
  NONE: null
};

function expectedFromState(stateKey) {
  return (stateKey in STATE_TO_EXPECTED) ? STATE_TO_EXPECTED[stateKey] : null;
}

// Phases shown on the 8 game slots
const GAME_PHASES = [
  "First defense",
  "First defense",
  "Second defense",
  "Second defense",
  "Third defense",
  "Third defense",
  "Refused attackers",
  "Leftovers"
];

// Prefer these labels, but if backend returns other scenario keys we’ll still show them.
const SCENARIO_LABELS = {
  HAMMER_ANVIL: "Hammer and Anvil",
  SEEK_DESTROY: "Seek and Destroy",
  CRUCIBLE_BATTLE: "Crucible Battle",
  TIPPING_POINTS: "Tipping Points",
  DAWN_OF_WAR: "Dawn of War",
  SWEEPING_ENGAGEMENT: "Sweeping Engagement"
};

// Global state
let gPlayers = [];
let gArmies = [];
let gMatrixStates = {};   // "playerId-armyIndex" -> STATE_KEY
let gPairings = [];       // 8 slots: {game_no, player_id, army_index, layout_n, real_score}
let gLayouts = {};        // scenarioKey -> [{n, file}, ...]

let gDirtyPairings = false;
let gActiveSlot = null;
let gScenario = null;

/* =========================
   Utilities
   ========================= */

function getPlayerId(player) {
  if (typeof player?.player_id === "number") return player.player_id; // roster snapshot
  if (typeof player?.id === "number") return player.id;              // legacy/global
  return null;
}

function getPlayerName(player) {
  return player?.player_name || player?.name || "Player";
}

function getPlayerListLabel(player) {
  // roster snapshot: frozen list_text
  if (typeof player?.list_text === "string" && player.list_text.trim()) {
    const firstLine = player.list_text.split(/\r?\n/).find(l => l.trim().length > 0) || "Default list";
    const trimmed = firstLine.trim();
    return trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed;
  }

  // legacy/global fallback
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

function setFightStatus(text, mode = "normal") {
  const el = document.getElementById("fight-status");
  if (!el) return;
  el.textContent = text;
  el.className = "status-text";
  if (mode === "unsaved") el.classList.add("unsaved");
  if (mode === "error") el.classList.add("error");
  if (mode === "saved") el.classList.add("saved");
}

function setFightNotes(comment) {
  const el = document.getElementById("fight-notes-display");
  if (!el) return;
  const text = (comment || "").trim();
  el.textContent = text ? comment : "—";
}

function markPairingsDirty() {
  gDirtyPairings = true;
  const btn = document.getElementById("fight-save-btn");
  if (btn) btn.disabled = false;
  setFightStatus("Pairings not saved.", "unsaved");
}

function applyStateVisual(cellInner, stateKey) {
  const cfg = STATE_CONFIG[stateKey] || STATE_CONFIG.NONE;
  cellInner.textContent = cfg.label;
  cellInner.style.background = cfg.bg;
  cellInner.style.borderColor = cfg.border;
  cellInner.style.color = cfg.color;
}

function getDefaultListLabel(player) {
  let defaultLabel = "";
  if (Array.isArray(player.lists) && typeof player.default_index === "number") {
    const idx = player.default_index;
    if (idx >= 0 && idx < player.lists.length) {
      const txt = player.lists[idx] || "";
      const firstLine = txt.split(/\r?\n/).find(l => l.trim().length > 0) || "Default list";
      defaultLabel = firstLine.trim();
      if (defaultLabel.length > 40) defaultLabel = defaultLabel.slice(0, 37) + "...";
    }
  }
  if (!defaultLabel) defaultLabel = "No default list";
  return defaultLabel;
}

function scenarioLabel(key) {
  if (!key) return "Scenario…";
  return SCENARIO_LABELS[key] || key.replaceAll("_", " ").toLowerCase();
}

function ensure8Slots(pairingsFromServer) {
  const byGameNo = {};
  (pairingsFromServer || []).forEach(p => {
    if (p && typeof p.game_no === "number") byGameNo[p.game_no] = p;
  });

  const slots = [];
  for (let i = 1; i <= 8; i++) {
    const existing = byGameNo[i];

    if (existing) {
      slots.push({
        game_no: i,
        player_id: (typeof existing.player_id === "number") ? existing.player_id : null,
        army_index: (typeof existing.army_index === "number") ? existing.army_index : null,
        layout_n: (typeof existing.layout_n === "number") ? existing.layout_n : null,
        real_score: (typeof existing.real_score === "number") ? existing.real_score : null
      });
    } else {
      slots.push({
        game_no: i,
        player_id: null,
        army_index: null,
        layout_n: null,
        real_score: null
      });
    }
  }
  return slots;
}

function getUsedLayoutsSet() {
  const used = new Set();
  gPairings.forEach(p => {
    if (gScenario && typeof p.layout_n === "number") {
      used.add(`${gScenario}-${p.layout_n}`);
    }
  });
  return used;
}

function populateLayoutOptions(selectEl, selectedN) {
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Layout #…";
  selectEl.appendChild(opt0);

  if (!gScenario) return;

  const layouts = gLayouts[gScenario] || [];
  if (!layouts.length) return;

  const used = getUsedLayoutsSet();

  layouts.forEach(({ n }) => {
    const key = `${gScenario}-${n}`;
    if (used.has(key) && n !== selectedN) return;

    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = `#${n}`;
    selectEl.appendChild(opt);
  });

  if (selectedN) selectEl.value = String(selectedN);
}

function renderLayoutsStrip() {
  const strip = document.getElementById("layouts-strip");
  if (!strip) return;
  strip.innerHTML = "";

  if (!gScenario) {
    const msg = document.createElement("div");
    msg.style.color = "#888";
    msg.style.fontSize = "0.85rem";
    msg.textContent = "Select a scenario to preview available layouts.";
    strip.appendChild(msg);
    return;
  }

  const layouts = gLayouts[gScenario] || [];
  const used = getUsedLayoutsSet();

  if (!layouts.length) {
    const msg = document.createElement("div");
    msg.style.color = "#ff8a80";
    msg.style.fontSize = "0.85rem";
    msg.textContent = "No images found for this scenario in /data.";
    strip.appendChild(msg);
    return;
  }

  layouts.forEach(({ n, file }) => {
    const key = `${gScenario}-${n}`;
    if (used.has(key)) return;

    const wrap = document.createElement("div");
    wrap.style.border = "1px solid rgba(255,255,255,0.12)";
    wrap.style.borderRadius = "10px";
    wrap.style.padding = "0.3rem";
    wrap.style.background = "rgba(0,0,0,0.35)";

    const label = document.createElement("div");
    label.style.fontSize = "0.7rem";
    label.style.color = "#bbb";
    label.style.marginBottom = "0.25rem";
    label.textContent = `Layout #${n}`;

    const img = document.createElement("img");
    img.src = `/layouts/${file}`;
    img.alt = file;
    img.style.width = "240px";
    img.style.maxWidth = "70vw";
    img.style.borderRadius = "8px";
    img.style.display = "block";

    wrap.appendChild(label);
    wrap.appendChild(img);
    strip.appendChild(wrap);
  });
}

/* =========================
   Rendering: Matrix + Slots + Summary
   ========================= */

function buildMatrixTable() {
  const table = document.getElementById("fight-matrix-table");
  if (!table) return;
  table.innerHTML = "";

  const usedRows = new Set(gPairings.filter(p => p.player_id).map(p => p.player_id));
  const usedCols = new Set(gPairings.filter(p => typeof p.army_index === "number").map(p => p.army_index));

  // ---- header
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

  // ---- body
  const tbody = document.createElement("tbody");

  gPlayers.forEach(player => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "sticky-col player-name-cell";

    const wrapper = document.createElement("div");
    const nameLine = document.createElement("div");

    const pid = getPlayerId(player);
    nameLine.textContent = getPlayerName(player) || `Player ${pid}`;
    const listLine = document.createElement("div");
    listLine.textContent = getPlayerListLabel(player);


    wrapper.appendChild(nameLine);
    wrapper.appendChild(listLine);
    nameTd.appendChild(wrapper);
    tr.appendChild(nameTd);

    gArmies.forEach((army, armyIdx) => {
      const td = document.createElement("td");
      td.className = "matrix-cell";
      const pid = getPlayerId(player);
      td.dataset.playerId = pid;
      td.dataset.armyIndex = armyIdx;

      // Used logic
      const usedRow = usedRows.has(pid);
      const usedCol = usedCols.has(armyIdx);
      if (usedRow || usedCol) td.classList.add("used");

      const inner = document.createElement("div");
      inner.className = "matrix-cell-inner";

      const key = `${pid}-${armyIdx}`;
      const stateKey = gMatrixStates[key] || "NONE";
      applyStateVisual(inner, stateKey);

      td.appendChild(inner);

      td.addEventListener("click", () => {
        if (!gActiveSlot) return;
        if (td.classList.contains("used")) return;

        const slot = gPairings.find(s => s.game_no === gActiveSlot);

        if (!gScenario) {
          alert("Select a Scenario first (Layouts section).");
          return;
        }

        const pid = getPlayerId(player);
        if (typeof pid !== "number") {
          alert("Invalid player id (roster snapshot mismatch).");
          return;
        }

        // Allow pairing first, layout later
        assignPairingToSlot(gActiveSlot, pid, armyIdx);

        // UX hint: remind user to pick a layout for this game
        const slotAfter = gPairings.find(s => s.game_no === gActiveSlot);
        if (slotAfter && !slotAfter.layout_n) {
          setFightStatus(
            `Pairing set for Game ${gActiveSlot}. Now choose a Layout # for this game.`,
            "unsaved"
          );
        }
      });


      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
}

function buildGameSlots() {
  const container = document.getElementById("games-list-container");
  if (!container) return;
  container.innerHTML = "";

  for (let i = 0; i < 8; i++) {
    const slot = gPairings[i];

    const card = document.createElement("div");
    card.className = "game-card";
    card.dataset.gameNo = slot.game_no;

    const header = document.createElement("div");
    header.className = "game-card-header";

    const left = document.createElement("div");
    const numSpan = document.createElement("div");
    numSpan.className = "game-number";
    numSpan.textContent = `Game ${slot.game_no}`;

    const phaseSpan = document.createElement("div");
    phaseSpan.className = "game-phase";
    phaseSpan.textContent = GAME_PHASES[slot.game_no - 1] || "";

    left.appendChild(numSpan);
    left.appendChild(phaseSpan);

    const right = document.createElement("div");
    const selectBtn = document.createElement("button");
    selectBtn.textContent = "Select pairing";
    selectBtn.style.marginTop = "0";
    selectBtn.addEventListener("click", () => setActiveSlot(slot.game_no));
    right.appendChild(selectBtn);

    header.appendChild(left);
    header.appendChild(right);
    card.appendChild(header);

    const content = document.createElement("div");
    content.className = "game-content";
    content.id = `game-content-${slot.game_no}`;
    card.appendChild(content);

    // Layout select
    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "0.4rem";
    controls.style.flexWrap = "wrap";
    controls.style.marginTop = "0.35rem";

    const layoutSelect = document.createElement("select");
    layoutSelect.style.background = "#111";
    layoutSelect.style.border = "1px solid #444";
    layoutSelect.style.borderRadius = "999px";
    layoutSelect.style.color = "#f5f5f5";
    layoutSelect.style.padding = "0.25rem 0.6rem";
    layoutSelect.style.fontSize = "0.7rem";

    populateLayoutOptions(layoutSelect, slot.layout_n);

    layoutSelect.addEventListener("change", () => {
      slot.layout_n = layoutSelect.value ? parseInt(layoutSelect.value, 10) : null;
      
      if (slot.layout_n !== null) {
        const usedByOther = gPairings.some(s =>
          s.game_no !== slot.game_no && typeof s.layout_n === "number" && s.layout_n === slot.layout_n
        );
        if (usedByOther) {
          alert("This layout number is already taken. Choose another.");
          slot.layout_n = null;
          layoutSelect.value = "";
          return;
        }
      }
      markPairingsDirty();
      refreshGameCards();
      refreshSummaryTable();

      if (gActiveSlot === slot.game_no) renderLayoutsStrip();
      refreshAllLayoutDropdowns();
    });

    controls.appendChild(layoutSelect);
    card.appendChild(controls);

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.style.marginTop = "0.35rem";
    clearBtn.style.fontSize = "0.65rem";
    clearBtn.style.padding = "0.25rem 0.7rem";
    clearBtn.addEventListener("click", () => {
      if (!confirm(`Clear Game ${slot.game_no}?`)) return;
      slot.player_id = null;
      slot.army_index = null;
      slot.layout_n = null;
      slot.real_score = null;
      markPairingsDirty();
      buildMatrixTable();
      refreshGameCards();
      refreshSummaryTable();
      refreshAllLayoutDropdowns();
      if (gActiveSlot === slot.game_no) renderLayoutsStrip();
    });
    card.appendChild(clearBtn);

    container.appendChild(card);
  }

  refreshGameCards();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
}

function refreshAllLayoutDropdowns() {
  const cards = document.querySelectorAll(".game-card");
  cards.forEach(card => {
    const gameNo = parseInt(card.dataset.gameNo, 10);
    const slot = gPairings.find(s => s.game_no === gameNo);
    if (!slot) return;

    const layoutSelect = card.querySelector("select");
    if (!layoutSelect) return;

    populateLayoutOptions(layoutSelect, slot.layout_n);
  });

  renderLayoutsStrip();
}

function refreshGameCards() {
  gPairings.forEach(slot => {
    const content = document.getElementById(`game-content-${slot.game_no}`);
    if (!content) return;
    content.innerHTML = "";

    const card = content.parentElement;
    if (card) card.classList.toggle("active", slot.game_no === gActiveSlot);

    if (!slot.player_id || typeof slot.army_index !== "number") {
      const span = document.createElement("span");
      span.textContent = "No pairing yet.";
      span.style.color = "#888";
      content.appendChild(span);

      const meta = document.createElement("span");
      meta.style.color = "#aaa";
      meta.style.marginTop = "0.1rem";
      meta.textContent = `Scenario: ${gScenario ? scenarioLabel(gScenario) : "—"} · Layout: ${slot.layout_n ? "#" + slot.layout_n : "—"}`;
      content.appendChild(meta);

      return;
    }

    const player = gPlayers.find(p => getPlayerId(p) === slot.player_id);
    
    const army = gArmies[slot.army_index];

    const pSpan = document.createElement("span");
    pSpan.textContent = (getPlayerName(player) || `Player ${slot.player_id}`) + " ";

    const listLabel = getPlayerListLabel(player || {});
    const listSpan = document.createElement("span");
    listSpan.textContent = `(${listLabel})`;

    const aSpan = document.createElement("span");
    aSpan.textContent = "vs " + (army?.faction || `Army #${slot.army_index + 1}`);

    const key = `${slot.player_id}-${slot.army_index}`;
    const stateKey = gMatrixStates[key] || "NONE";
    const cfg = STATE_CONFIG[stateKey] || STATE_CONFIG.NONE;

    const rating = document.createElement("span");
    rating.className = "game-rating-badge";
    rating.style.background = cfg.bg;
    rating.style.borderColor = cfg.border;
    rating.style.color = cfg.color || "#f5f5f5";
    rating.textContent = cfg.label || "N/A";

    const meta = document.createElement("span");
    meta.style.color = "#aaa";
    meta.style.marginTop = "0.1rem";
    meta.textContent = `Scenario: ${gScenario ? scenarioLabel(gScenario) : "—"} · Layout: ${slot.layout_n ? "#" + slot.layout_n : "—"}`;

    content.appendChild(pSpan);
    content.appendChild(listSpan);
    content.appendChild(aSpan);
    content.appendChild(rating);
    content.appendChild(meta);
  });
}

function refreshSummaryTable() {
  const table = document.getElementById("pairings-summary-table");
  const statusEl = document.getElementById("summary-status");
  if (!table || !statusEl) return;

  table.innerHTML = "";

  const existingBox = document.getElementById("team-total-box");
  if (existingBox) existingBox.remove();

  const filled = gPairings.filter(p => p.player_id && typeof p.army_index === "number");
  if (!filled.length) {
    statusEl.textContent = "No pairings yet. Start with Game 1.";
    statusEl.className = "status-text";
    return;
  }

  statusEl.textContent = `${filled.length} / 8 games assigned.`;
  statusEl.className = "status-text";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const headers = ["Game", "Phase", "Your player & list", "Opponent codex", "Scenario", "Layout", "Matchup", "Expected", "Real", "Δ"];
  headers.forEach(h => {
    const th = document.createElement("th");
    th.textContent = h;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const sorted = [...filled].sort((a, b) => a.game_no - b.game_no);

  let totalReal = 0;
  let realCount = 0;

  sorted.forEach(slot => {
    const tr = document.createElement("tr");

    const tdGame = document.createElement("td");
    tdGame.textContent = slot.game_no;
    tr.appendChild(tdGame);

    const tdPhase = document.createElement("td");
    tdPhase.textContent = GAME_PHASES[slot.game_no - 1] || "";
    tr.appendChild(tdPhase);

    const tdPlayer = document.createElement("td");
    const player = gPlayers.find(p => getPlayerId(p) === slot.player_id);
    const name = getPlayerName(player) || `Player ${slot.player_id}`;
    const listLabel = getPlayerListLabel(player || {});
    tdPlayer.textContent = `${name} (${listLabel})`;
    tr.appendChild(tdPlayer);

    const tdArmy = document.createElement("td");
    const army = gArmies[slot.army_index];
    tdArmy.textContent = army?.faction || `Army #${slot.army_index + 1}`;
    tr.appendChild(tdArmy);

    const tdScenario = document.createElement("td");
    tdScenario.textContent = gScenario ? scenarioLabel(gScenario) : "—";
    tr.appendChild(tdScenario);

    const tdLayout = document.createElement("td");
    tdLayout.textContent = slot.layout_n ? `#${slot.layout_n}` : "—";
    tr.appendChild(tdLayout);

    // Matchup badge
    const key = `${slot.player_id}-${slot.army_index}`;
    const stateKey = gMatrixStates[key] || "NONE";
    const cfg = STATE_CONFIG[stateKey] || STATE_CONFIG.NONE;
    const exp = expectedFromState(stateKey);

    const tdMatch = document.createElement("td");
    const badge = document.createElement("span");
    badge.style.display = "inline-block";
    badge.style.padding = "0.1rem 0.5rem";
    badge.style.borderRadius = "999px";
    badge.style.fontSize = "0.7rem";
    badge.style.border = `1px solid ${cfg.border}`;
    badge.style.background = cfg.bg;
    badge.style.color = cfg.color || "#f5f5f5";
    badge.textContent = cfg.label || "N/A";
    tdMatch.appendChild(badge);
    tr.appendChild(tdMatch);

    const tdExpected = document.createElement("td");
    tdExpected.textContent = (typeof exp === "number") ? exp.toFixed(1) : "—";
    tr.appendChild(tdExpected);

    // Real score input
    const tdReal = document.createElement("td");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "20";
    input.step = "1";
    input.value = (typeof slot.real_score === "number") ? String(slot.real_score) : "";
    input.placeholder = "0-20";
    input.style.width = "70px";
    input.style.background = "#111";
    input.style.border = "1px solid #444";
    input.style.borderRadius = "10px";
    input.style.color = "#f5f5f5";
    input.style.padding = "0.25rem 0.45rem";

    input.addEventListener("change", () => {
      const v = input.value.trim();
      slot.real_score = v === "" ? null : Math.max(0, Math.min(20, parseInt(v, 10)));
      input.value = (slot.real_score === null) ? "" : String(slot.real_score);
      markPairingsDirty();
      refreshSummaryTable();
    });

    tdReal.appendChild(input);
    tr.appendChild(tdReal);

    // Delta
    const tdDelta = document.createElement("td");
    if (typeof exp === "number" && typeof slot.real_score === "number") {
      const d = slot.real_score - exp;
      tdDelta.textContent = (d >= 0 ? "+" : "") + d.toFixed(1);
      tdDelta.style.color = d >= 0 ? "#66bb6a" : "#ff8a80";
    } else {
      tdDelta.textContent = "—";
      tdDelta.style.color = "#aaa";
    }
    tr.appendChild(tdDelta);

    if (typeof slot.real_score === "number") {
      totalReal += slot.real_score;
      realCount += 1;
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);

  // Totals box
  const box = document.createElement("div");
  box.id = "team-total-box";
  box.style.marginTop = "0.75rem";
  box.style.display = "flex";
  box.style.flexWrap = "wrap";
  box.style.gap = "0.6rem";
  box.style.alignItems = "center";

  const totalPill = document.createElement("div");
  totalPill.className = "status-text";
  totalPill.style.padding = "0.35rem 0.8rem";
  totalPill.style.border = "1px solid rgba(255,255,255,0.12)";
  totalPill.style.borderRadius = "999px";
  totalPill.style.background = "rgba(0,0,0,0.35)";
  totalPill.textContent = `Total real: ${totalReal} / 160 (${realCount}/8 filled)`;

  const resultPill = document.createElement("div");
  resultPill.style.padding = "0.35rem 0.8rem";
  resultPill.style.borderRadius = "999px";
  resultPill.style.border = "1px solid rgba(255,255,255,0.12)";
  resultPill.style.background = "rgba(0,0,0,0.35)";
  resultPill.style.textTransform = "uppercase";
  resultPill.style.letterSpacing = "0.12em";

  let verdict = "—";
  if (realCount === 8) {
    if (totalReal < 75) verdict = "Loss";
    else if (totalReal <= 85) verdict = "Draw";
    else verdict = "Win";
  }
  resultPill.textContent = `Result: ${verdict}`;

  box.appendChild(totalPill);
  box.appendChild(resultPill);

  table.parentElement.appendChild(box);
}

function setActiveSlot(gameNo) {
  gActiveSlot = gameNo;

  const cards = document.querySelectorAll(".game-card");
  cards.forEach(card => {
    const no = parseInt(card.dataset.gameNo, 10);
    card.classList.toggle("active", no === gameNo);
  });

  renderLayoutsStrip();
  setFightStatus(`Selecting pairing for Game ${gameNo}. Choose Scenario/Layout, then click a matrix cell.`, "unsaved");
}

function assignPairingToSlot(gameNo, playerId, armyIndex) {
  // Enforce unique player and unique opponent army across slots.
  gPairings.forEach(slot => {
    if (slot.game_no !== gameNo) {
      if (slot.player_id === playerId || slot.army_index === armyIndex) {
        slot.player_id = null;
        slot.army_index = null;
        slot.real_score = null;
      }
    }
  });

  const slot = gPairings.find(s => s.game_no === gameNo);
  if (slot) {
    slot.player_id = playerId;
    slot.army_index = armyIndex;
  }

  buildMatrixTable();
  refreshGameCards();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();

  markPairingsDirty();
}

/* =========================
   Save / Reset
   ========================= */

async function savePairings() {
  if (!gDirtyPairings) return;

  const btn = document.getElementById("fight-save-btn");
  if (btn) btn.disabled = true;
  setFightStatus("Saving...");

  try {
    const res = await fetch(`/api/games/${window.GAME_ID}/pairings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: gScenario, pairings: gPairings })
    });
    const data = await res.json();

    if (!res.ok) {
      console.error(data);
      setFightStatus(data.error || "Error saving pairings.", "error");
      if (btn) btn.disabled = false;
      return;
    }

    gDirtyPairings = false;
    setFightStatus("Pairings saved.", "saved");
    refreshSummaryTable();
  } catch (err) {
    console.error(err);
    setFightStatus("Network or server error while saving.", "error");
    if (btn) btn.disabled = false;
  }
}

function resetPairings() {
  if (!confirm("Reset all pairings and start from scratch?")) return;

  gScenario = null;
  const scenarioSelect = document.getElementById("scenario-select");
  if (scenarioSelect) scenarioSelect.value = "";

  gPairings = [];
  for (let i = 1; i <= 8; i++) {
    gPairings.push({ game_no: i, player_id: null, army_index: null, layout_n: null, real_score: null });
  }

  buildGameSlots();
  buildMatrixTable();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
  renderLayoutsStrip();

  gDirtyPairings = true;
  const btn = document.getElementById("fight-save-btn");
  if (btn) btn.disabled = false;

  setFightStatus("Pairings reset. Pick Game 1 and start again.", "unsaved");
  setActiveSlot(1);
}

/* =========================
   Data loading
   ========================= */

async function loadFightData() {
  setFightStatus("Loading...");
  const saveBtn = document.getElementById("fight-save-btn");
  if (saveBtn) saveBtn.disabled = true;

  // 1) Load matrix + players
  const resMatrix = await fetch(`/api/games/${window.GAME_ID}/matrix`);
  if (!resMatrix.ok) {
    setFightStatus("Error loading matrix.", "error");
    throw new Error("Failed to load matrix");
  }
  const dataMatrix = await resMatrix.json();
  const game = dataMatrix.game;

  gPlayers = dataMatrix.players || [];
  gArmies = game.armies || [];
  gMatrixStates = dataMatrix.matrix || {};
  setFightNotes(game?.comment || "");

  const oppLabel = document.getElementById("fight-opponent-label");
  const cntLabel = document.getElementById("fight-army-count-label");
  if (oppLabel) oppLabel.textContent = `Opponent: ${game.opponent_name || "Unknown"}`;
  if (cntLabel) cntLabel.textContent = `${gArmies.length} codex`;

  // 2) Load layouts inventory
  const resLayouts = await fetch("/api/layouts");
  gLayouts = resLayouts.ok ? await resLayouts.json() : {};

  // 3) Load existing pairings
  const resPairings = await fetch(`/api/games/${window.GAME_ID}/pairings`);
  let pairingsData = { pairings: [] };
  if (resPairings.ok) pairingsData = await resPairings.json();

  gPairings = ensure8Slots(pairingsData.pairings);

  gScenario = pairingsData.scenario || null;
  const scenarioSelect = document.getElementById("scenario-select");
  if (scenarioSelect) scenarioSelect.value = gScenario || "";

  buildGameSlots();
  buildMatrixTable();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
  renderLayoutsStrip();

  gDirtyPairings = false;
  setFightStatus("Loaded. Start with Game 1.");
  setActiveSlot(1);
}

/* =========================
   Init
   ========================= */

document.addEventListener("DOMContentLoaded", async () => {
  const saveBtn = document.getElementById("fight-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", savePairings);

  const resetBtn = document.getElementById("fight-reset-btn");
  if (resetBtn) resetBtn.addEventListener("click", resetPairings);

  const scenarioSelect = document.getElementById("scenario-select");
  if (scenarioSelect) {
    scenarioSelect.addEventListener("change", () => {
      const newScenario = scenarioSelect.value || null;

      // If changing scenario mid-run, clear ALL chosen layouts (but keep pairings)
      if (gScenario && newScenario && gScenario !== newScenario) {
        const ok = confirm("Changing scenario will clear all selected layout numbers. Continue?");
        if (!ok) {
          scenarioSelect.value = gScenario;
          return;
        }
        gPairings.forEach(p => { p.layout_n = null; });
        markPairingsDirty();
      }

      gScenario = newScenario;
      renderLayoutsStrip();
      refreshAllLayoutDropdowns();
      refreshGameCards();
      refreshSummaryTable();
    });
  }

  try {
    await loadFightData();
  } catch (err) {
    console.error(err);
  }
});
