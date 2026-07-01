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

// Expected score mapping used by the pairing assistant / summary
const STATE_TO_EXPECTED = {
  HELP: 0.0,
  LOOSE: 5.0,
  S_LOOSE: 8.0,
  S_WIN: 12.0,
  WIN: 15.0,
  EASY: 20.0,
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

const FORCE_DISPOSITIONS = [
  "Priority assets",
  "Recon",
  "Take and hold",
  "Purge the foes",
  "Disruption"
];

// Global state
let gPlayers = [];
let gArmies = [];
let gMatrixStates = {};   // "playerId-armyIndex" -> STATE_KEY
let gPairings = [];       // 8 slots: {game_no, player_id, army_index, terrain_map_id, real_score}
let gTerrainLayouts = {}; // "priority_assets_vs_recon" -> [{id, n, label, file, placeholder}, ...]

let gDirtyPairings = false;
let gActiveSlot = null;
let gScenario = null;     // legacy field kept for existing games
let gAutoSaveTimer = null;
let gSaveInFlight = false;
let gSaveQueued = false;
let gAssistantOurDefender = null;
let gAssistantEnemyDefender = null;
let gAssistantEnemyAttackPair = [];
let gAssistantAcceptedOurAttacker = null;
let gAssistantReportFirstDefender = null;
let gAssistantReportSecondDefender = null;
let gAssistantReportEnemyFirstDefender = null;
let gAssistantReportEnemySecondDefender = null;
let gAssistantLatest = null;
let gAssistantReportLatest = null;
let gAssistantRequestSeq = 0;
let gAssistantReportRequestSeq = 0;
let gAssistantReportKey = "";
const AUTO_SAVE_DELAY_MS = 700;

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
  if (typeof player?.list_name === "string" && player.list_name.trim()) {
    return player.list_name.trim();
  }

  if (Array.isArray(player?.list_names) && typeof player?.default_index === "number") {
    const idx = player.default_index;
    if (idx >= 0 && idx < player.list_names.length) {
      const name = player.list_names[idx] || "";
      if (name.trim()) return name.trim();
    }
  }

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

function getPlayerForceDisposition(player) {
  if (typeof player?.list_force_disposition === "string" && player.list_force_disposition.trim()) {
    return player.list_force_disposition.trim();
  }

  if (Array.isArray(player?.list_force_dispositions) && typeof player?.default_index === "number") {
    const idx = player.default_index;
    if (idx >= 0 && idx < player.list_force_dispositions.length) {
      return (player.list_force_dispositions[idx] || "").trim();
    }
  }

  return "";
}

function formatPlayerListWithForceDisposition(player) {
  const listLabel = getPlayerListLabel(player);
  const forceDisposition = getPlayerForceDisposition(player);
  return forceDisposition ? `${listLabel} · ${forceDisposition}` : listLabel;
}

function getOpponentPlayerName(army, idx) {
  const trimmed = (army?.player_name || "").trim();
  return trimmed || `Opponent #${idx + 1}`;
}

function getOpponentFactionLabel(army, idx) {
  const trimmed = (army?.faction || "").trim();
  return trimmed || `Army #${idx + 1}`;
}

function getOpponentForceDisposition(army) {
  return (army?.force_disposition || "").trim();
}

function normalizeForceDisposition(value) {
  const raw = (value || "").trim();
  return FORCE_DISPOSITIONS.find(item => item.toLowerCase() === raw.toLowerCase()) || "";
}

function slugifyTerrainPart(value) {
  const normalized = normalizeForceDisposition(value);
  return normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function terrainPairKey(ourForceDisposition, opponentForceDisposition) {
  const ourSlug = slugifyTerrainPart(ourForceDisposition);
  const opponentSlug = slugifyTerrainPart(opponentForceDisposition);
  if (!ourSlug || !opponentSlug) return "";
  return `${ourSlug}_vs_${opponentSlug}`;
}

function getPlayerBySlot(slot) {
  if (!slot || typeof slot.player_id !== "number") return null;
  return gPlayers.find(player => getPlayerId(player) === slot.player_id) || null;
}

function getArmyBySlot(slot) {
  if (!slot || typeof slot.army_index !== "number") return null;
  return gArmies[slot.army_index] || null;
}

function getTerrainOptionsForSlot(slot) {
  const player = getPlayerBySlot(slot);
  const army = getArmyBySlot(slot);
  const key = terrainPairKey(getPlayerForceDisposition(player || {}), getOpponentForceDisposition(army || {}));
  return key ? (gTerrainLayouts[key] || []) : [];
}

function getTerrainOptionForSlot(slot) {
  const terrainId = (slot?.terrain_map_id || "").trim();
  if (!terrainId) return null;
  return getTerrainOptionsForSlot(slot).find(option => option.id === terrainId) || null;
}

function getTerrainCombinationLabelForSlot(slot) {
  const player = getPlayerBySlot(slot);
  const army = getArmyBySlot(slot);
  const ourForce = getPlayerForceDisposition(player || {});
  const opponentForce = getOpponentForceDisposition(army || {});
  if (!ourForce || !opponentForce) return "";
  return `${ourForce} vs ${opponentForce}`;
}

function getTerrainLabelForSlot(slot) {
  if (!slot || !slot.player_id || typeof slot.army_index !== "number") return "—";
  const combination = getTerrainCombinationLabelForSlot(slot);
  const selected = getTerrainOptionForSlot(slot);
  if (selected) return `${combination} · ${selected.label}`;
  return combination ? `${combination} · not selected` : "Force disposition missing";
}

function setTerrainForSlot(slot, terrainMapId) {
  if (!slot) return;
  slot.terrain_map_id = terrainMapId || null;
  slot.layout_n = null;
  markPairingsDirty();
  if (terrainMapId) {
    setFightStatus(`Terrain selected for Game ${slot.game_no}.`, "unsaved");
  }
  refreshGameCards();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
  if (gActiveSlot === slot.game_no) renderLayoutsStrip();
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
  scheduleAutoSave();
}

function scheduleAutoSave() {
  if (gAutoSaveTimer) clearTimeout(gAutoSaveTimer);
  gAutoSaveTimer = setTimeout(() => {
    gAutoSaveTimer = null;
    savePairings({ auto: true });
  }, AUTO_SAVE_DELAY_MS);
}

function normalizeRealScore(rawValue) {
  const v = rawValue.trim();
  if (v === "") return null;
  const parsed = parseInt(v, 10);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.min(20, parsed));
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
        terrain_map_id: (typeof existing.terrain_map_id === "string" && existing.terrain_map_id.trim()) ? existing.terrain_map_id.trim() : null,
        real_score: (typeof existing.real_score === "number") ? existing.real_score : null
      });
    } else {
      slots.push({
        game_no: i,
        player_id: null,
        army_index: null,
        layout_n: null,
        terrain_map_id: null,
        real_score: null
      });
    }
  }
  return slots;
}

function populateLayoutOptions(selectEl, slot) {
  selectEl.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Terrain map…";
  selectEl.appendChild(opt0);

  if (!slot || !slot.player_id || typeof slot.army_index !== "number") {
    selectEl.disabled = true;
    opt0.textContent = "Select matchup first";
    return;
  }

  const options = getTerrainOptionsForSlot(slot);
  if (!options.length) {
    selectEl.disabled = true;
    opt0.textContent = "Missing force disposition";
    return;
  }

  selectEl.disabled = false;
  options.forEach(option => {
    const opt = document.createElement("option");
    opt.value = option.id;
    opt.textContent = option.placeholder ? `${option.label} (placeholder)` : option.label;
    selectEl.appendChild(opt);
  });

  selectEl.value = slot.terrain_map_id || "";
}

function renderLayoutsStrip() {
  const strip = document.getElementById("layouts-strip");
  const hint = document.getElementById("terrain-hint");
  if (!strip) return;
  strip.innerHTML = "";

  const slot = gPairings.find(item => item.game_no === gActiveSlot);
  if (!slot || !slot.player_id || typeof slot.army_index !== "number") {
    const msg = document.createElement("div");
    msg.className = "terrain-empty";
    msg.textContent = "Select a game and click a matrix matchup to reveal its 3 terrain map choices.";
    strip.appendChild(msg);
    if (hint) hint.textContent = "Terrain options appear after a matchup is selected.";
    return;
  }

  const combination = getTerrainCombinationLabelForSlot(slot);
  const options = getTerrainOptionsForSlot(slot);
  if (!options.length) {
    const msg = document.createElement("div");
    msg.className = "terrain-empty terrain-error";
    msg.textContent = "This matchup is missing a force disposition, so terrain maps cannot be proposed.";
    strip.appendChild(msg);
    if (hint) hint.textContent = "Add force dispositions to both lists to enable terrain choices.";
    return;
  }

  if (hint) hint.textContent = `${combination}: choose one of the 3 terrain maps.`;

  options.forEach(option => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "terrain-card";
    if (slot.terrain_map_id === option.id) card.classList.add("selected");

    const title = document.createElement("span");
    title.className = "terrain-card-title";
    title.textContent = option.label;
    card.appendChild(title);

    const meta = document.createElement("span");
    meta.className = "terrain-card-meta";
    meta.textContent = option.placeholder ? "Image placeholder" : combination;
    card.appendChild(meta);

    if (option.file) {
      const img = document.createElement("img");
      img.src = `/layouts/${option.file}`;
      img.alt = `${combination} ${option.label}`;
      card.appendChild(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "terrain-placeholder";
      placeholder.textContent = "Map image pending";
      card.appendChild(placeholder);
    }

    card.addEventListener("click", () => setTerrainForSlot(slot, option.id));
    strip.appendChild(card);
  });
}

function describePlayerInfo(info) {
  if (!info) return "—";
  const name = info.name || "Unknown player";
  const listName = (info.list_name || "").trim();
  const forceDisposition = (info.force_disposition || "").trim();
  const detail = [listName, forceDisposition].filter(Boolean).join(" · ");
  return detail ? `${name} (${detail})` : name;
}

function describeArmyInfo(info) {
  if (!info) return "—";
  const playerName = info.player_name || `Opponent #${(info.army_index ?? 0) + 1}`;
  const faction = info.faction || `Army #${(info.army_index ?? 0) + 1}`;
  const forceDisposition = (info.force_disposition || "").trim();
  return forceDisposition ? `${playerName} (${faction} · ${forceDisposition})` : `${playerName} (${faction})`;
}

function setAssistantStatus(text, mode = "normal") {
  const el = document.getElementById("assistant-status");
  if (!el) return;
  el.textContent = text;
  el.className = "status-text";
  if (mode === "error") el.classList.add("error");
  if (mode === "saved") el.classList.add("saved");
  if (mode === "unsaved") el.classList.add("unsaved");
}

function setAssistantReportStatus(text, mode = "normal") {
  const el = document.getElementById("assistant-report-status");
  if (!el) return;
  el.textContent = text;
  el.className = "assistant-subtle";
  if (mode === "error") el.classList.add("error");
  if (mode === "saved") el.classList.add("saved");
  if (mode === "unsaved") el.classList.add("unsaved");
}

function renderAssistantReport(data) {
  const outputEl = document.getElementById("assistant-report-output");
  if (!outputEl) return;

  if (!data?.report_text) {
    outputEl.textContent = "No mirror report generated yet. Click Generate mirror report to analyze the current round with the selected defender override, or with the solver recommendation if no override is set.";
    return;
  }

  outputEl.textContent = data.report_text;
}

function clearAssistantReport() {
  gAssistantReportLatest = null;
  gAssistantReportKey = "";
  renderAssistantReport(null);
  setAssistantReportStatus("Mirror report is not generated for this state yet. Click Generate mirror report.", "unsaved");
}

function fillAssistantPlayerSelect(selectEl, players, selectedValue, defaultText, disabled, disabledText = "Not available.") {
  if (!selectEl) return;

  selectEl.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = disabled ? disabledText : defaultText;
  selectEl.appendChild(defaultOption);

  if (!disabled) {
    players.forEach(player => {
      const opt = document.createElement("option");
      opt.value = String(player.player_id);
      opt.textContent = describePlayerInfo(player);
      selectEl.appendChild(opt);
    });
  }

  selectEl.value = (typeof selectedValue === "number") ? String(selectedValue) : "";
  selectEl.disabled = disabled;
}

function fillAssistantArmySelect(selectEl, armies, selectedValue, defaultText, disabled, disabledText = "Not available.") {
  if (!selectEl) return;

  selectEl.innerHTML = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = disabled ? disabledText : defaultText;
  selectEl.appendChild(defaultOption);

  if (!disabled) {
    armies.forEach(army => {
      const opt = document.createElement("option");
      opt.value = String(army.army_index);
      opt.textContent = describeArmyInfo(army);
      selectEl.appendChild(opt);
    });
  }

  selectEl.value = (typeof selectedValue === "number") ? String(selectedValue) : "";
  selectEl.disabled = disabled;
}

function buildAssistantReportPayload() {
  const payload = { pairings: gPairings };
  if (typeof gAssistantOurDefender === "number") {
    payload.our_defender = gAssistantOurDefender;
  }
  if (typeof gAssistantReportFirstDefender === "number") {
    payload.report_first_defender = gAssistantReportFirstDefender;
  }
  if (typeof gAssistantReportSecondDefender === "number") {
    payload.report_second_defender = gAssistantReportSecondDefender;
  }
  if (typeof gAssistantReportEnemyFirstDefender === "number") {
    payload.report_enemy_first_defender = gAssistantReportEnemyFirstDefender;
  }
  if (typeof gAssistantReportEnemySecondDefender === "number") {
    payload.report_enemy_second_defender = gAssistantReportEnemySecondDefender;
  }
  return payload;
}

function resetAssistantState() {
  gAssistantOurDefender = null;
  gAssistantEnemyDefender = null;
  gAssistantEnemyAttackPair = [];
  gAssistantAcceptedOurAttacker = null;
  gAssistantReportFirstDefender = null;
  gAssistantReportSecondDefender = null;
  gAssistantReportEnemyFirstDefender = null;
  gAssistantReportEnemySecondDefender = null;
  gAssistantLatest = null;
  clearAssistantReport();
}

function createAssistantPill(text) {
  const pill = document.createElement("span");
  pill.className = "assistant-pill";
  pill.textContent = text;
  return pill;
}

function renderAssistantScoreMap(scoreMap) {
  const box = document.getElementById("assistant-score-map");
  if (!box) return;
  box.innerHTML = "";

  if (!scoreMap) return;

  [
    `GD ${scoreMap.grosse_defaite}`,
    `D ${scoreMap.defaite}`,
    `PD ${scoreMap.petite_defaite}`,
    `PV ${scoreMap.petite_victoire}`,
    `V ${scoreMap.victoire}`,
    `GV ${scoreMap.grosse_victoire}`,
  ].forEach(text => box.appendChild(createAssistantPill(text)));
}

function renderAssistantPreview(plan) {
  const box = document.getElementById("assistant-preview");
  if (!box) return;
  box.innerHTML = "";

  if (!Array.isArray(plan) || !plan.length) {
    const empty = document.createElement("div");
    empty.className = "assistant-subtle";
    empty.textContent = "Select an opponent defender, then the two enemy attackers, to preview the round.";
    box.appendChild(empty);
    return;
  }

  plan.forEach(item => {
    const row = document.createElement("div");
    row.className = "assistant-preview-item";

    const left = document.createElement("div");
    left.textContent = `G${item.game_no} · ${GAME_PHASES[item.game_no - 1] || ""}`;

    const right = document.createElement("div");
    right.textContent = `${item.player_name} vs ${item.opponent_name} (${item.opponent_faction})`;

    row.appendChild(left);
    row.appendChild(right);
    box.appendChild(row);
  });
}

function renderAssistant(data) {
  const phaseEl = document.getElementById("assistant-phase");
  const ourDefEl = document.getElementById("assistant-our-defender");
  const guaranteedEl = document.getElementById("assistant-guaranteed");
  const ourDefenderSelect = document.getElementById("assistant-our-defender-select");
  const selectedGuaranteedEl = document.getElementById("assistant-selected-guaranteed");
  const reportFirstDefenderSelect = document.getElementById("assistant-report-first-defender-select");
  const reportSecondDefenderSelect = document.getElementById("assistant-report-second-defender-select");
  const reportEnemyFirstDefenderSelect = document.getElementById("assistant-report-enemy-first-defender-select");
  const reportEnemySecondDefenderSelect = document.getElementById("assistant-report-enemy-second-defender-select");
  const attackersEl = document.getElementById("assistant-attackers");
  const acceptEl = document.getElementById("assistant-accept");
  const enemyAcceptEl = document.getElementById("assistant-enemy-accept");
  const enemyAcceptSelect = document.getElementById("assistant-enemy-accept-select");
  const refusedEl = document.getElementById("assistant-refused");
  const leftoversEl = document.getElementById("assistant-leftovers");
  const projectedEl = document.getElementById("assistant-projected");
  const nextPhaseEl = document.getElementById("assistant-next-phase");
  const nextOurDefenderEl = document.getElementById("assistant-next-our-defender");
  const defenderSelect = document.getElementById("assistant-enemy-defender-select");
  const enemyAttackersBox = document.getElementById("assistant-enemy-attackers");
  const applyBtn = document.getElementById("assistant-apply-btn");

  if (phaseEl) phaseEl.textContent = data?.phase?.label || "—";
  if (ourDefEl) ourDefEl.textContent = describePlayerInfo(data?.our_best_defender);
  if (guaranteedEl) guaranteedEl.textContent = (typeof data?.guaranteed_score === "number") ? `${data.guaranteed_score.toFixed(1)} pts` : "—";
  if (selectedGuaranteedEl) {
    selectedGuaranteedEl.textContent = (typeof data?.selected_our_defender_score === "number")
      ? `${data.selected_our_defender_score.toFixed(1)} pts`
      : "—";
  }
  if (attackersEl) {
    if (Array.isArray(data?.suggested_attackers) && data.suggested_attackers.length) {
      attackersEl.textContent = data.suggested_attackers.map(describePlayerInfo).join(" + ");
    } else if (data?.phase?.kind === "complete") {
      attackersEl.textContent = "Round already complete.";
    } else {
      attackersEl.textContent = "Select an opponent defender first.";
    }
  }
  if (acceptEl) acceptEl.textContent = describeArmyInfo(data?.suggested_accept_enemy);
  if (enemyAcceptEl) enemyAcceptEl.textContent = describePlayerInfo(data?.enemy_should_accept_our);
  if (enemyAcceptSelect) {
    enemyAcceptSelect.innerHTML = "";

    const attackers = Array.isArray(data?.suggested_attackers) ? data.suggested_attackers : [];
    const selectedEnemyPairReady = Array.isArray(data?.selected_enemy_attack_pair) && data.selected_enemy_attack_pair.length === 2;
    const validPlayerIds = new Set(attackers.map(player => player.player_id));
    if (!validPlayerIds.has(gAssistantAcceptedOurAttacker)) {
      gAssistantAcceptedOurAttacker = null;
    }

    if (!selectedEnemyPairReady || !attackers.length) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Resolve attack pair first…";
      enemyAcceptSelect.appendChild(placeholder);
      enemyAcceptSelect.disabled = true;
    } else {
      attackers.forEach(player => {
        const opt = document.createElement("option");
        opt.value = String(player.player_id);
        opt.textContent = describePlayerInfo(player);
        enemyAcceptSelect.appendChild(opt);
      });

      const selectedPlayerId =
        data?.selected_enemy_accept_our?.player_id ??
        gAssistantAcceptedOurAttacker ??
        data?.enemy_should_accept_our?.player_id;
      gAssistantAcceptedOurAttacker = (typeof selectedPlayerId === "number") ? selectedPlayerId : null;
      enemyAcceptSelect.value = (typeof selectedPlayerId === "number") ? String(selectedPlayerId) : "";
      enemyAcceptSelect.disabled = data?.phase?.kind === "complete";
    }
  }
  if (refusedEl) {
    if (data?.refused_our_attacker && data?.refused_enemy_attacker) {
      refusedEl.textContent = `${describePlayerInfo(data.refused_our_attacker)} / ${describeArmyInfo(data.refused_enemy_attacker)}`;
    } else {
      refusedEl.textContent = "—";
    }
  }
  if (leftoversEl) {
    if (data?.our_leftover && data?.their_leftover) {
      leftoversEl.textContent = `${describePlayerInfo(data.our_leftover)} / ${describeArmyInfo(data.their_leftover)}`;
    } else if (data?.phase?.kind === "round3") {
      leftoversEl.textContent = "Select the enemy attack pair to reveal the last table.";
    } else {
      leftoversEl.textContent = "Not used in this round.";
    }
  }
  if (projectedEl) projectedEl.textContent = (typeof data?.projected_score === "number") ? `${data.projected_score.toFixed(1)} pts` : "—";
  if (nextPhaseEl) {
    if (data?.next_phase?.label) {
      nextPhaseEl.textContent = data.next_phase.label;
    } else {
      nextPhaseEl.textContent = "Resolve this round first.";
    }
  }
  if (nextOurDefenderEl) {
    if (data?.next_phase?.kind === "complete") {
      nextOurDefenderEl.textContent = "No next defense.";
    } else if (data?.next_our_defender) {
      nextOurDefenderEl.textContent = describePlayerInfo(data.next_our_defender);
    } else {
      nextOurDefenderEl.textContent = "—";
    }
  }

  renderAssistantScoreMap(data?.score_map);
  renderAssistantPreview(data?.apply_plan);

  const players = Array.isArray(data?.remaining_players) ? data.remaining_players : [];
  const armies = Array.isArray(data?.remaining_armies) ? data.remaining_armies : [];
  const validPlayerIds = new Set(players.map(player => player.player_id));
  const validArmyIds = new Set(armies.map(army => army.army_index));
  if (!validPlayerIds.has(gAssistantOurDefender)) {
    gAssistantOurDefender = null;
  }
  if (!validPlayerIds.has(gAssistantReportFirstDefender)) {
    gAssistantReportFirstDefender = null;
  }
  if (!validPlayerIds.has(gAssistantReportSecondDefender)) {
    gAssistantReportSecondDefender = null;
  }
  if (!validArmyIds.has(gAssistantReportEnemyFirstDefender)) {
    gAssistantReportEnemyFirstDefender = null;
  }
  if (!validArmyIds.has(gAssistantReportEnemySecondDefender)) {
    gAssistantReportEnemySecondDefender = null;
  }

  const phaseLabel = data?.phase?.label || "";
  const canForceReportFirst = phaseLabel === "First defense";
  const canForceReportSecond = phaseLabel === "First defense" || phaseLabel === "Second defense";

  if (ourDefenderSelect) {
    fillAssistantPlayerSelect(
      ourDefenderSelect,
      players,
      gAssistantOurDefender,
      "Use suggested defender...",
      !players.length || data?.phase?.kind === "complete",
      "No defender available."
    );
  }

  if (reportFirstDefenderSelect) {
    fillAssistantPlayerSelect(
      reportFirstDefenderSelect,
      players,
      gAssistantReportFirstDefender,
      "Use current first defense choice...",
      !players.length || !canForceReportFirst,
      phaseLabel === "First defense" ? "No defender available." : "First defense already locked."
    );
  }

  if (reportSecondDefenderSelect) {
    fillAssistantPlayerSelect(
      reportSecondDefenderSelect,
      players,
      gAssistantReportSecondDefender,
      "Use solver on second defense...",
      !players.length || !canForceReportSecond,
      canForceReportSecond ? "No defender available." : "Second defense already locked."
    );
  }

  if (reportEnemyFirstDefenderSelect) {
    fillAssistantArmySelect(
      reportEnemyFirstDefenderSelect,
      armies,
      gAssistantReportEnemyFirstDefender,
      "Use mirror opponent first defense...",
      !armies.length || !canForceReportFirst,
      phaseLabel === "First defense" ? "No codex available." : "First defense already locked."
    );
  }

  if (reportEnemySecondDefenderSelect) {
    fillAssistantArmySelect(
      reportEnemySecondDefenderSelect,
      armies,
      gAssistantReportEnemySecondDefender,
      "Use mirror opponent second defense...",
      !armies.length || !canForceReportSecond,
      canForceReportSecond ? "No codex available." : "Second defense already locked."
    );
  }

  if (defenderSelect) {
    const previousValue = gAssistantEnemyDefender;
    defenderSelect.innerHTML = "";

    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Choose opponent defender…";
    defenderSelect.appendChild(defaultOption);

    const availableIndices = new Set(armies.map(army => army.army_index));
    if (!availableIndices.has(previousValue)) {
      gAssistantEnemyDefender = null;
      gAssistantEnemyAttackPair = [];
      gAssistantAcceptedOurAttacker = null;
    }

    armies.forEach(army => {
      const opt = document.createElement("option");
      opt.value = String(army.army_index);
      opt.textContent = describeArmyInfo(army);
      defenderSelect.appendChild(opt);
    });

    defenderSelect.value = (typeof gAssistantEnemyDefender === "number") ? String(gAssistantEnemyDefender) : "";
    defenderSelect.disabled = !armies.length || data?.phase?.kind === "complete";
  }

  if (enemyAttackersBox) {
    enemyAttackersBox.innerHTML = "";

    const armies = Array.isArray(data?.remaining_armies) ? data.remaining_armies : [];
    const selectable = armies.filter(army => army.army_index !== gAssistantEnemyDefender);
    const validSelections = gAssistantEnemyAttackPair.filter(idx => selectable.some(army => army.army_index === idx));
    gAssistantEnemyAttackPair = validSelections;

    if (data?.phase?.kind === "complete") {
      const msg = document.createElement("div");
      msg.className = "assistant-subtle";
      msg.textContent = "All games are already assigned.";
      enemyAttackersBox.appendChild(msg);
    } else if (typeof gAssistantEnemyDefender !== "number") {
      const msg = document.createElement("div");
      msg.className = "assistant-subtle";
      msg.textContent = "Pick the opponent defender to enable this step.";
      enemyAttackersBox.appendChild(msg);
    } else {
      selectable.forEach(army => {
        const label = document.createElement("label");
        label.className = "assistant-check";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = gAssistantEnemyAttackPair.includes(army.army_index);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            if (gAssistantEnemyAttackPair.length >= 2) {
              checkbox.checked = false;
              setAssistantStatus("Select exactly two enemy attackers.", "unsaved");
              return;
            }
            gAssistantEnemyAttackPair = [...gAssistantEnemyAttackPair, army.army_index].sort((a, b) => a - b);
          } else {
            gAssistantEnemyAttackPair = gAssistantEnemyAttackPair.filter(idx => idx !== army.army_index);
          }
          gAssistantAcceptedOurAttacker = null;
          refreshAssistantAdvice();
        });

        const text = document.createElement("span");
        text.textContent = describeArmyInfo(army);

        label.appendChild(checkbox);
        label.appendChild(text);
        enemyAttackersBox.appendChild(label);
      });
    }
  }

  if (applyBtn) {
    applyBtn.disabled = !(Array.isArray(data?.apply_plan) && data.apply_plan.length);
  }
}

function applyAssistantPlan(plan) {
  if (!Array.isArray(plan) || !plan.length) return;

  const targetGames = new Set(plan.map(item => item.game_no));
  const targetPlayers = new Set(plan.map(item => item.player_id));
  const targetArmies = new Set(plan.map(item => item.army_index));

  gPairings.forEach(slot => {
    if (!targetGames.has(slot.game_no)) {
      if (targetPlayers.has(slot.player_id) || targetArmies.has(slot.army_index)) {
        slot.player_id = null;
        slot.army_index = null;
        slot.layout_n = null;
        slot.terrain_map_id = null;
        slot.real_score = null;
      }
    }
  });

  plan.forEach(item => {
    const slot = gPairings.find(s => s.game_no === item.game_no);
    if (!slot) return;
    const pairingChanged = slot.player_id !== item.player_id || slot.army_index !== item.army_index;
    slot.player_id = item.player_id;
    slot.army_index = item.army_index;
    if (pairingChanged) {
      slot.layout_n = null;
      slot.terrain_map_id = null;
      slot.real_score = null;
    }
  });

  buildMatrixTable();
  refreshGameCards();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
  markPairingsDirty();

  const missingTerrain = plan
    .map(item => gPairings.find(s => s.game_no === item.game_no))
    .filter(slot => slot && !slot.terrain_map_id)
    .map(slot => slot.game_no);

  if (missingTerrain.length) {
    const suffix = missingTerrain.length === 1 ? "" : "s";
    setFightStatus(
      `Suggested round applied. Choose terrain map${suffix} for Game${suffix} ${missingTerrain.join(", ")}.`,
      "unsaved"
    );
  } else {
    setFightStatus("Suggested round applied. Save when ready.", "unsaved");
  }

  const nextSlot =
    gPairings.find(s => !s.player_id || typeof s.army_index !== "number");
  if (nextSlot) {
    gActiveSlot = nextSlot.game_no;
    renderLayoutsStrip();
  }

  resetAssistantState();
  refreshGameCards();
  refreshAssistantAdvice();
}

async function refreshAssistantAdvice() {
  const phaseEl = document.getElementById("assistant-phase");
  if (!phaseEl) return;

  const requestSeq = ++gAssistantRequestSeq;
  setAssistantStatus("Computing advice...");

  const payload = { pairings: gPairings };
  if (typeof gAssistantOurDefender === "number") {
    payload.our_defender = gAssistantOurDefender;
  }
  if (typeof gAssistantEnemyDefender === "number") {
    payload.enemy_defender = gAssistantEnemyDefender;
  }
  if (gAssistantEnemyAttackPair.length === 2) {
    payload.enemy_attack_pair = [...gAssistantEnemyAttackPair].sort((a, b) => a - b);
  }
  if (typeof gAssistantAcceptedOurAttacker === "number") {
    payload.accepted_our_attacker = gAssistantAcceptedOurAttacker;
  }

  try {
    const res = await fetch(`/api/games/${window.GAME_ID}/fight-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (requestSeq !== gAssistantRequestSeq) return;

    if (!res.ok) {
      gAssistantLatest = null;
      renderAssistant(null);
      clearAssistantReport();
      setAssistantStatus(data.error || "Failed to compute pairing advice.", "error");
      return;
    }

    gAssistantLatest = data;
    renderAssistant(data);

    if (data.phase?.kind === "complete") {
      setAssistantStatus("All 8 games are already assigned.", "saved");
    } else if (!data.selected_enemy_defender) {
      setAssistantStatus("Pick the opponent defender to get the recommended attack pair.");
    } else if (!(Array.isArray(data.selected_enemy_attack_pair) && data.selected_enemy_attack_pair.length === 2)) {
      setAssistantStatus("Select the two enemy attackers shown on your defender.");
    } else if (data.next_phase?.kind && data.next_phase.kind !== "complete") {
      setAssistantStatus(`Round resolved. Apply it to continue with ${data.next_phase.label}.`);
    } else if (data.next_phase?.kind === "complete") {
      setAssistantStatus("Final round resolved. Apply it to lock the last games.");
    } else {
      setAssistantStatus("Solver recommendation ready.");
    }
  } catch (err) {
    console.error(err);
    if (requestSeq !== gAssistantRequestSeq) return;
    gAssistantLatest = null;
    renderAssistant(null);
    clearAssistantReport();
    setAssistantStatus("Network or server error while computing pairing advice.", "error");
  }
}

async function generateAssistantReport(options = {}) {
  const { force = false } = options;
  const phaseEl = document.getElementById("assistant-phase");
  if (!phaseEl) return;

  const payload = buildAssistantReportPayload();
  const reportKey = JSON.stringify(payload);
  if (!force && reportKey === gAssistantReportKey && gAssistantReportLatest) {
    return;
  }

  const requestSeq = ++gAssistantReportRequestSeq;
  setAssistantReportStatus("Updating mirror scenarios...");

  try {
    const res = await fetch(`/api/games/${window.GAME_ID}/fight-assistant-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (requestSeq !== gAssistantReportRequestSeq) return;

    if (!res.ok) {
      gAssistantReportLatest = null;
      gAssistantReportKey = "";
      renderAssistantReport(null);
      setAssistantReportStatus(data.error || "Failed to generate mirror report.", "error");
      return;
    }

    gAssistantReportLatest = data;
    gAssistantReportKey = reportKey;
    renderAssistantReport(data);
    const displayedCount = typeof data.displayed_scenario_count === "number"
      ? data.displayed_scenario_count
      : data.scenario_count;
    setAssistantReportStatus(
      `Loaded ${displayedCount} detailed mirror scenarios from ${data.scenario_count} branch lines.`,
      "saved"
    );
  } catch (err) {
    console.error(err);
    if (requestSeq !== gAssistantReportRequestSeq) return;
    gAssistantReportLatest = null;
    gAssistantReportKey = "";
    renderAssistantReport(null);
    setAssistantReportStatus("Network or server error while generating mirror report.", "error");
  }
}

/* =========================
   Rendering: Matrix + Slots + Summary
   ========================= */

function buildMatrixTable() {
  const table = document.getElementById("fight-matrix-table");
  if (!table) return;
  table.innerHTML = "";

  const usedRows = new Set(
    gPairings
      .filter(p => typeof p.player_id === "number")
      .map(p => p.player_id)
  );
  const usedCols = new Set(
    gPairings
      .filter(p => typeof p.army_index === "number")
      .map(p => p.army_index)
  );

  const visiblePlayers = gPlayers
    .map(player => ({ player, pid: getPlayerId(player) }))
    .filter(({ pid }) => !usedRows.has(pid));
  const visibleArmies = gArmies
    .map((army, idx) => ({ army, idx }))
    .filter(({ idx }) => !usedCols.has(idx));

  // ---- header
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  const cornerTh = document.createElement("th");
  cornerTh.className = "sticky-col";
  cornerTh.textContent = "Player \\ Opponent";
  headerRow.appendChild(cornerTh);

  visibleArmies.forEach(({ army, idx }) => {
    const th = document.createElement("th");

    const headerDiv = document.createElement("div");
    headerDiv.className = "faction-header";

    const playerSpan = document.createElement("div");
    playerSpan.className = "opponent-player-name";
    playerSpan.textContent = getOpponentPlayerName(army, idx);
    headerDiv.appendChild(playerSpan);

    const factionSpan = document.createElement("div");
    factionSpan.className = "opponent-faction-name";
    factionSpan.textContent = getOpponentFactionLabel(army, idx);
    headerDiv.appendChild(factionSpan);

    const forceSpan = document.createElement("div");
    forceSpan.className = "opponent-force-disposition";
    forceSpan.textContent = getOpponentForceDisposition(army) || "No force disposition";
    headerDiv.appendChild(forceSpan);

    const tooltip = document.createElement("div");
    tooltip.className = "faction-tooltip";
    const forceMeta = document.createElement("div");
    forceMeta.className = "tooltip-meta";
    forceMeta.textContent = `Force disposition: ${getOpponentForceDisposition(army) || "—"}`;
    tooltip.appendChild(forceMeta);
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

  visiblePlayers.forEach(({ player, pid }) => {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    nameTd.className = "sticky-col player-name-cell";

    const wrapper = document.createElement("div");
    const nameLine = document.createElement("div");

    nameLine.textContent = getPlayerName(player) || `Player ${pid}`;
    const listLine = document.createElement("div");
    listLine.textContent = formatPlayerListWithForceDisposition(player);


    wrapper.appendChild(nameLine);
    wrapper.appendChild(listLine);
    nameTd.appendChild(wrapper);
    tr.appendChild(nameTd);

    visibleArmies.forEach(({ army, idx: armyIdx }) => {
      const td = document.createElement("td");
      td.className = "matrix-cell";
      td.dataset.playerId = pid;
      td.dataset.armyIndex = armyIdx;

      const inner = document.createElement("div");
      inner.className = "matrix-cell-inner";

      const key = `${pid}-${armyIdx}`;
      const stateKey = gMatrixStates[key] || "NONE";
      applyStateVisual(inner, stateKey);

      td.appendChild(inner);

      td.addEventListener("click", () => {
        if (!gActiveSlot) return;
        const selectedGameNo = gActiveSlot;

        const pid = getPlayerId(player);
        if (typeof pid !== "number") {
          alert("Invalid player id (roster snapshot mismatch).");
          return;
        }

        // Allow pairing first, terrain later
        assignPairingToSlot(selectedGameNo, pid, armyIdx);

        // UX hint: remind user to pick a terrain map for this game
        const slotAfter = gPairings.find(s => s.game_no === selectedGameNo);
        if (slotAfter && !slotAfter.terrain_map_id) {
          setFightStatus(
            `Pairing set for Game ${selectedGameNo}. Choose one of the 3 terrain maps for this force disposition matchup.`,
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

    // Terrain select
    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.gap = "0.4rem";
    controls.style.flexWrap = "wrap";
    controls.style.marginTop = "0.35rem";

    const layoutSelect = document.createElement("select");
    layoutSelect.className = "terrain-select";
    layoutSelect.style.background = "#111";
    layoutSelect.style.border = "1px solid #444";
    layoutSelect.style.borderRadius = "999px";
    layoutSelect.style.color = "#f5f5f5";
    layoutSelect.style.padding = "0.25rem 0.6rem";
    layoutSelect.style.fontSize = "0.7rem";

    populateLayoutOptions(layoutSelect, slot);

    layoutSelect.addEventListener("change", () => {
      setTerrainForSlot(slot, layoutSelect.value || null);
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
      slot.terrain_map_id = null;
      slot.real_score = null;
      markPairingsDirty();
      buildMatrixTable();
      refreshGameCards();
      refreshSummaryTable();
      refreshAllLayoutDropdowns();
      if (gActiveSlot === slot.game_no) renderLayoutsStrip();
      resetAssistantState();
      refreshAssistantAdvice();
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

    const layoutSelect = card.querySelector("select.terrain-select");
    if (!layoutSelect) return;

    populateLayoutOptions(layoutSelect, slot);
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
      meta.textContent = `Terrain: ${getTerrainLabelForSlot(slot)}`;
      content.appendChild(meta);

      return;
    }

    const player = gPlayers.find(p => getPlayerId(p) === slot.player_id);
    
    const army = gArmies[slot.army_index];

    const pSpan = document.createElement("span");
    pSpan.textContent = (getPlayerName(player) || `Player ${slot.player_id}`) + " ";

    const listLabel = formatPlayerListWithForceDisposition(player || {});
    const listSpan = document.createElement("span");
    listSpan.textContent = `(${listLabel})`;

    const aSpan = document.createElement("span");
    aSpan.textContent =
      "vs " + getOpponentPlayerName(army, slot.army_index) + " (" + [getOpponentFactionLabel(army, slot.army_index), getOpponentForceDisposition(army)].filter(Boolean).join(" · ") + ")";

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
    meta.textContent = `Terrain: ${getTerrainLabelForSlot(slot)}`;

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
  const headers = ["Game", "Phase", "Your player & list", "Opponent codex", "Terrain", "Matchup", "Expected", "Real", "Δ"];
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
    const listLabel = formatPlayerListWithForceDisposition(player || {});
    tdPlayer.textContent = `${name} (${listLabel})`;
    tr.appendChild(tdPlayer);

    const tdArmy = document.createElement("td");
    const army = gArmies[slot.army_index];
    const armyDetail = [getOpponentFactionLabel(army, slot.army_index), getOpponentForceDisposition(army)].filter(Boolean).join(" · ");
    tdArmy.textContent = `${getOpponentPlayerName(army, slot.army_index)} (${armyDetail})`;
    tr.appendChild(tdArmy);

    const tdTerrain = document.createElement("td");
    tdTerrain.textContent = getTerrainLabelForSlot(slot);
    tr.appendChild(tdTerrain);

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

    const handleScoreInput = () => {
      slot.real_score = normalizeRealScore(input.value);
      markPairingsDirty();
    };

    const handleScoreChange = () => {
      slot.real_score = normalizeRealScore(input.value);
      input.value = (slot.real_score === null) ? "" : String(slot.real_score);
      markPairingsDirty();
      refreshSummaryTable();
    };

    input.addEventListener("input", handleScoreInput);
    input.addEventListener("change", handleScoreChange);

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
  setFightStatus(`Selecting pairing for Game ${gameNo}. Click a matrix cell, then choose one of its 3 terrain maps.`, "unsaved");
}

function assignPairingToSlot(gameNo, playerId, armyIndex) {
  // Enforce unique player and unique opponent army across slots.
  gPairings.forEach(slot => {
    if (slot.game_no !== gameNo) {
      if (slot.player_id === playerId || slot.army_index === armyIndex) {
        slot.player_id = null;
        slot.army_index = null;
        slot.layout_n = null;
        slot.terrain_map_id = null;
        slot.real_score = null;
      }
    }
  });

  const slot = gPairings.find(s => s.game_no === gameNo);
  if (slot) {
    const pairingChanged = slot.player_id !== playerId || slot.army_index !== armyIndex;
    slot.player_id = playerId;
    slot.army_index = armyIndex;
    if (pairingChanged) {
      slot.layout_n = null;
      slot.terrain_map_id = null;
      slot.real_score = null;
    }
  }

  buildMatrixTable();
  refreshGameCards();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();

  markPairingsDirty();

  resetAssistantState();
  refreshAssistantAdvice();
}

/* =========================
   Save / Reset
   ========================= */

async function savePairings(options = {}) {
  const { auto = false } = options;
  if (!gDirtyPairings) return;
  if (gSaveInFlight) {
    gSaveQueued = true;
    return;
  }

  if (gAutoSaveTimer) {
    clearTimeout(gAutoSaveTimer);
    gAutoSaveTimer = null;
  }

  const btn = document.getElementById("fight-save-btn");
  if (btn) btn.disabled = true;
  setFightStatus("Saving...");
  gSaveInFlight = true;

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
      return;
    }

    gDirtyPairings = false;
    setFightStatus(auto ? "Changes auto-saved." : "Pairings saved.", "saved");
    refreshSummaryTable();
  } catch (err) {
    console.error(err);
    setFightStatus("Network or server error while saving.", "error");
  } finally {
    gSaveInFlight = false;
    if (btn) btn.disabled = false;
    if (gSaveQueued && gDirtyPairings) {
      gSaveQueued = false;
      savePairings({ auto: true });
    } else {
      gSaveQueued = false;
    }
  }
}

function resetPairings() {
  if (!confirm("Reset all pairings and start from scratch?")) return;

  gScenario = null;

  gPairings = [];
  for (let i = 1; i <= 8; i++) {
    gPairings.push({ game_no: i, player_id: null, army_index: null, layout_n: null, terrain_map_id: null, real_score: null });
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
  resetAssistantState();
  refreshAssistantAdvice();
  scheduleAutoSave();
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

  // 2) Load force-disposition terrain inventory
  const resTerrainLayouts = await fetch("/api/terrain-layouts");
  const terrainData = resTerrainLayouts.ok ? await resTerrainLayouts.json() : {};
  gTerrainLayouts = terrainData.combinations || {};

  // 3) Load existing pairings
  const resPairings = await fetch(`/api/games/${window.GAME_ID}/pairings`);
  let pairingsData = { pairings: [] };
  if (resPairings.ok) pairingsData = await resPairings.json();

  gPairings = ensure8Slots(pairingsData.pairings);

  gScenario = pairingsData.scenario || null;

  buildGameSlots();
  buildMatrixTable();
  refreshSummaryTable();
  refreshAllLayoutDropdowns();
  renderLayoutsStrip();

  gDirtyPairings = false;
  setFightStatus("Loaded. Start with Game 1.");
  setActiveSlot(1);
  resetAssistantState();
  refreshAssistantAdvice();
}

/* =========================
   Init
   ========================= */

document.addEventListener("DOMContentLoaded", async () => {
  const saveBtn = document.getElementById("fight-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", () => savePairings({ auto: false }));

  const resetBtn = document.getElementById("fight-reset-btn");
  if (resetBtn) resetBtn.addEventListener("click", resetPairings);

  const assistantRefreshBtn = document.getElementById("assistant-refresh-btn");
  if (assistantRefreshBtn) assistantRefreshBtn.addEventListener("click", refreshAssistantAdvice);

  const assistantApplyBtn = document.getElementById("assistant-apply-btn");
  if (assistantApplyBtn) {
    assistantApplyBtn.addEventListener("click", () => {
      if (Array.isArray(gAssistantLatest?.apply_plan) && gAssistantLatest.apply_plan.length) {
        applyAssistantPlan(gAssistantLatest.apply_plan);
      }
    });
  }

  const assistantGenerateReportBtn = document.getElementById("assistant-generate-report-btn");
  if (assistantGenerateReportBtn) {
    assistantGenerateReportBtn.addEventListener("click", () => {
      generateAssistantReport({ force: true });
    });
  }

  const assistantReportFirstDefenderSelect = document.getElementById("assistant-report-first-defender-select");
  if (assistantReportFirstDefenderSelect) {
    assistantReportFirstDefenderSelect.addEventListener("change", () => {
      gAssistantReportFirstDefender = assistantReportFirstDefenderSelect.value
        ? parseInt(assistantReportFirstDefenderSelect.value, 10)
        : null;
      clearAssistantReport();
    });
  }

  const assistantReportSecondDefenderSelect = document.getElementById("assistant-report-second-defender-select");
  if (assistantReportSecondDefenderSelect) {
    assistantReportSecondDefenderSelect.addEventListener("change", () => {
      gAssistantReportSecondDefender = assistantReportSecondDefenderSelect.value
        ? parseInt(assistantReportSecondDefenderSelect.value, 10)
        : null;
      clearAssistantReport();
    });
  }

  const assistantReportEnemyFirstDefenderSelect = document.getElementById("assistant-report-enemy-first-defender-select");
  if (assistantReportEnemyFirstDefenderSelect) {
    assistantReportEnemyFirstDefenderSelect.addEventListener("change", () => {
      gAssistantReportEnemyFirstDefender = assistantReportEnemyFirstDefenderSelect.value
        ? parseInt(assistantReportEnemyFirstDefenderSelect.value, 10)
        : null;
      clearAssistantReport();
    });
  }

  const assistantReportEnemySecondDefenderSelect = document.getElementById("assistant-report-enemy-second-defender-select");
  if (assistantReportEnemySecondDefenderSelect) {
    assistantReportEnemySecondDefenderSelect.addEventListener("change", () => {
      gAssistantReportEnemySecondDefender = assistantReportEnemySecondDefenderSelect.value
        ? parseInt(assistantReportEnemySecondDefenderSelect.value, 10)
        : null;
      clearAssistantReport();
    });
  }

  const assistantDefenderSelect = document.getElementById("assistant-enemy-defender-select");
  if (assistantDefenderSelect) {
    assistantDefenderSelect.addEventListener("change", () => {
      gAssistantEnemyDefender = assistantDefenderSelect.value ? parseInt(assistantDefenderSelect.value, 10) : null;
      gAssistantEnemyAttackPair = [];
      gAssistantAcceptedOurAttacker = null;
      refreshAssistantAdvice();
    });
  }

  const assistantOurDefenderSelect = document.getElementById("assistant-our-defender-select");
  if (assistantOurDefenderSelect) {
    assistantOurDefenderSelect.addEventListener("change", () => {
      gAssistantOurDefender = assistantOurDefenderSelect.value ? parseInt(assistantOurDefenderSelect.value, 10) : null;
      gAssistantAcceptedOurAttacker = null;
      clearAssistantReport();
      refreshAssistantAdvice();
    });
  }

  const assistantEnemyAcceptSelect = document.getElementById("assistant-enemy-accept-select");
  if (assistantEnemyAcceptSelect) {
    assistantEnemyAcceptSelect.addEventListener("change", () => {
      gAssistantAcceptedOurAttacker = assistantEnemyAcceptSelect.value ? parseInt(assistantEnemyAcceptSelect.value, 10) : null;
      refreshAssistantAdvice();
    });
  }

  try {
    await loadFightData();
  } catch (err) {
    console.error(err);
  }
});
