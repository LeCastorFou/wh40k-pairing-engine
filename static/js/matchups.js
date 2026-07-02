let gMatchupData = {
  matches: [],
  players: [],
  factions: [],
  force_dispositions: [],
  deployments: []
};

function el(id) {
  return document.getElementById(id);
}

function localToday() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function setStatus(message, tone = "") {
  const status = el("form-status");
  status.textContent = message;
  status.className = "status";
  if (tone) status.classList.add(tone);
}

function clearSelect(selectEl, placeholder) {
  selectEl.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = placeholder;
  selectEl.appendChild(option);
}

function fillSelect(selectEl, values, placeholder) {
  clearSelect(selectEl, placeholder);
  values.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  });
}

function fillPlayerSelect(selectEl, placeholder) {
  clearSelect(selectEl, placeholder);
  gMatchupData.players.forEach(player => {
    const option = document.createElement("option");
    option.value = String(player.id);
    option.textContent = player.name;
    selectEl.appendChild(option);
  });
}

function selectedPlayer() {
  const playerId = parseInt(el("player-select").value, 10);
  if (!Number.isInteger(playerId)) return null;
  return gMatchupData.players.find(player => player.id === playerId) || null;
}

function updateListSelect() {
  const listSelect = el("player-list-select");
  clearSelect(listSelect, "No list selected");

  const player = selectedPlayer();
  if (!player) {
    el("player-force-select").value = "";
    return;
  }

  const lists = Array.isArray(player.lists) ? player.lists : [];
  if (!lists.length) {
    if (player.default_force_disposition) {
      el("player-force-select").value = player.default_force_disposition;
    }
    return;
  }

  lists.forEach(list => {
    const option = document.createElement("option");
    option.value = String(list.index);
    option.textContent = list.name || `List #${list.index + 1}`;
    option.dataset.forceDisposition = list.force_disposition || "";
    listSelect.appendChild(option);
  });

  const defaultIndex = Number.isInteger(player.default_index) ? player.default_index : 0;
  const defaultOption = Array.from(listSelect.options).find(option => parseInt(option.value, 10) === defaultIndex);
  if (defaultOption) {
    listSelect.value = defaultOption.value;
  } else if (listSelect.options.length > 1) {
    listSelect.selectedIndex = 1;
  }
  applySelectedListForce();
}

function applySelectedListForce() {
  const listSelect = el("player-list-select");
  const option = listSelect.selectedOptions[0];
  const force = option?.dataset?.forceDisposition || "";
  if (force) el("player-force-select").value = force;
}

function resultFromScore(score) {
  if (!Number.isInteger(score)) return "";
  if (score > 10) return "WIN";
  if (score < 10) return "LOSS";
  return "DRAW";
}

function resetForm(keepDate = true) {
  const currentDate = el("game-date").value;
  el("matchup-form").reset();
  el("game-date").value = keepDate && currentDate ? currentDate : localToday();
  el("opponent-level-select").value = "3";
  updateListSelect();
  setStatus("");
}

async function loadMatchups() {
  const res = await fetch("/api/matchups");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load matchup data");
  gMatchupData = data;
  populateControls();
  render();
}

function populateControls() {
  fillPlayerSelect(el("player-select"), "Select player");
  fillPlayerSelect(el("player-filter"), "All players");
  fillSelect(el("faction-select"), gMatchupData.factions || [], "Select faction");
  fillSelect(el("faction-filter"), gMatchupData.factions || [], "All factions");
  fillSelect(el("deployment-select"), gMatchupData.deployments || [], "Select deployment");
  fillSelect(el("deployment-filter"), gMatchupData.deployments || [], "All deployments");
  fillSelect(el("player-force-select"), gMatchupData.force_dispositions || [], "Select our disposition");
  fillSelect(el("opponent-force-select"), gMatchupData.force_dispositions || [], "Select opponent disposition");
  fillSelect(el("our-force-filter"), gMatchupData.force_dispositions || [], "All our dispositions");
  fillSelect(el("opponent-force-filter"), gMatchupData.force_dispositions || [], "All opponent dispositions");

  if (!el("game-date").value) el("game-date").value = localToday();
}

function fieldText(match) {
  return [
    match.player_name,
    match.player_list_name,
    match.opponent_name,
    match.event_name,
    match.faction,
    match.deployment,
    match.player_force_disposition,
    match.opponent_force_disposition,
    match.comment
  ].join(" ").toLowerCase();
}

function filteredMatches() {
  const search = el("search-filter").value.trim().toLowerCase();
  const playerId = parseInt(el("player-filter").value, 10);
  const faction = el("faction-filter").value;
  const deployment = el("deployment-filter").value;
  const result = el("result-filter").value;
  const firstTurn = el("first-turn-filter").value;
  const minRaw = el("score-min-filter").value;
  const maxRaw = el("score-max-filter").value;
  const minScore = minRaw === "" ? null : parseInt(minRaw, 10);
  const maxScore = maxRaw === "" ? null : parseInt(maxRaw, 10);
  const ourForce = el("our-force-filter").value;
  const opponentForce = el("opponent-force-filter").value;

  return (gMatchupData.matches || []).filter(match => {
    if (search && !fieldText(match).includes(search)) return false;
    if (Number.isInteger(playerId) && match.player_id !== playerId) return false;
    if (faction && match.faction !== faction) return false;
    if (deployment && match.deployment !== deployment) return false;
    if (result && match.result !== result) return false;
    if (firstTurn) {
      const expected = firstTurn === "true";
      if (match.has_first_turn !== expected) return false;
    }
    if (Number.isInteger(minScore) && (!Number.isInteger(match.score) || match.score < minScore)) return false;
    if (Number.isInteger(maxScore) && (!Number.isInteger(match.score) || match.score > maxScore)) return false;
    if (ourForce && match.player_force_disposition !== ourForce) return false;
    if (opponentForce && match.opponent_force_disposition !== opponentForce) return false;
    return true;
  });
}

function averageScore(matches) {
  const scored = matches.filter(match => Number.isInteger(match.score));
  if (!scored.length) return null;
  return scored.reduce((total, match) => total + match.score, 0) / scored.length;
}

function formatAverage(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

function renderMetrics(matches) {
  const wins = matches.filter(match => match.result === "WIN").length;
  const losses = matches.filter(match => match.result === "LOSS").length;
  const firstTurnMatches = matches.filter(match => match.has_first_turn === true);
  const noFirstTurnMatches = matches.filter(match => match.has_first_turn === false);
  const decisive = wins + losses;

  el("metric-games").textContent = String(matches.length);
  el("metric-average").textContent = formatAverage(averageScore(matches));
  el("metric-winrate").textContent = decisive ? `${((wins / decisive) * 100).toFixed(1)}%` : "—";
  el("metric-t1-average").textContent = formatAverage(averageScore(firstTurnMatches));
  el("metric-not1-average").textContent = formatAverage(averageScore(noFirstTurnMatches));
}

function appendTextCell(row, text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text || "—";
  if (className) cell.className = className;
  row.appendChild(cell);
  return cell;
}

function resultClass(result) {
  if (result === "WIN") return "res-win";
  if (result === "DRAW") return "res-draw";
  if (result === "LOSS") return "res-loss";
  return "muted";
}

function formatDate(value) {
  if (!value) return "—";
  return String(value).replace("T", " ").slice(0, 10);
}

function turnLabel(value) {
  if (value === true) return "We had T1";
  if (value === false) return "Opponent T1";
  return "—";
}

function dispositionLabel(match) {
  const ours = match.player_force_disposition || "—";
  const theirs = match.opponent_force_disposition || "—";
  return `${ours} / ${theirs}`;
}

async function deleteMatchup(match) {
  if (!confirm(`Delete this game for ${match.player_name || "this player"}?`)) return;
  const res = await fetch(`/api/matchups/${match.player_id}/${match.id}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(data.error || "Failed to delete game", "error");
    return;
  }
  await loadMatchups();
  setStatus("Game deleted.", "success");
}

function renderRows(matches) {
  const tbody = el("matchups-tbody");
  const empty = el("empty-state");
  tbody.innerHTML = "";
  empty.style.display = matches.length ? "none" : "block";

  matches.forEach(match => {
    const row = document.createElement("tr");

    appendTextCell(row, formatDate(match.date), "muted");
    appendTextCell(row, match.player_name);
    appendTextCell(row, match.player_list_name, "muted");
    appendTextCell(row, match.opponent_name || match.event_name || "—", "muted");
    appendTextCell(row, match.faction);

    const scoreCell = appendTextCell(row, Number.isInteger(match.score) ? `${match.score}/20` : "—", "num");
    scoreCell.title = Number.isInteger(match.score) ? `Result: ${resultFromScore(match.score)}` : "";

    appendTextCell(row, match.result || "—", resultClass(match.result));
    appendTextCell(row, turnLabel(match.has_first_turn), "muted");
    appendTextCell(row, match.deployment, "muted");
    appendTextCell(row, dispositionLabel(match), "muted");
    appendTextCell(row, Number.isInteger(match.opponent_level) ? `L${match.opponent_level}` : "—", "muted");
    appendTextCell(row, match.comment, "note-cell");

    const actionCell = document.createElement("td");
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn-ghost";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => deleteMatchup(match));
    actionCell.appendChild(deleteBtn);
    row.appendChild(actionCell);

    tbody.appendChild(row);
  });
}

function render() {
  const matches = filteredMatches();
  renderMetrics(matches);
  renderRows(matches);
}

function clearFilters() {
  [
    "search-filter",
    "player-filter",
    "faction-filter",
    "deployment-filter",
    "result-filter",
    "first-turn-filter",
    "score-min-filter",
    "score-max-filter",
    "our-force-filter",
    "opponent-force-filter"
  ].forEach(id => { el(id).value = ""; });
  render();
}

async function saveMatchup(event) {
  event.preventDefault();
  setStatus("");

  const playerId = parseInt(el("player-select").value, 10);
  const score = parseInt(el("score-input").value, 10);
  const firstTurnValue = el("first-turn-select").value;
  if (!Number.isInteger(playerId)) {
    setStatus("Select a player.", "error");
    return;
  }
  if (!Number.isInteger(score) || score < 0 || score > 20) {
    setStatus("Score must be between 0 and 20.", "error");
    return;
  }
  if (!firstTurnValue) {
    setStatus("Select who had turn 1.", "error");
    return;
  }

  const selectedList = el("player-list-select").selectedOptions[0];
  const payload = {
    player_id: playerId,
    date: el("game-date").value,
    faction: el("faction-select").value,
    score,
    has_first_turn: firstTurnValue === "true",
    deployment: el("deployment-select").value,
    opponent_level: parseInt(el("opponent-level-select").value, 10),
    player_force_disposition: el("player-force-select").value,
    opponent_force_disposition: el("opponent-force-select").value,
    opponent_name: el("opponent-name-input").value.trim(),
    event_name: el("event-name-input").value.trim(),
    player_list_name: selectedList && selectedList.value ? selectedList.textContent.trim() : "",
    comment: el("comment-input").value.trim()
  };

  const btn = el("save-matchup-btn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/matchups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || "Failed to add game.", "error");
      return;
    }
    resetForm(true);
    await loadMatchups();
    setStatus("Game added to matchup data.", "success");
  } catch (error) {
    setStatus(error.message || "Network error.", "error");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  el("game-date").value = localToday();
  el("matchup-form").addEventListener("submit", saveMatchup);
  el("reset-form-btn").addEventListener("click", () => resetForm(false));
  el("player-select").addEventListener("change", updateListSelect);
  el("player-list-select").addEventListener("change", applySelectedListForce);
  el("clear-filters-btn").addEventListener("click", clearFilters);

  [
    "search-filter",
    "score-min-filter",
    "score-max-filter"
  ].forEach(id => el(id).addEventListener("input", render));

  [
    "player-filter",
    "faction-filter",
    "deployment-filter",
    "result-filter",
    "first-turn-filter",
    "our-force-filter",
    "opponent-force-filter"
  ].forEach(id => el(id).addEventListener("change", render));

  try {
    await loadMatchups();
    updateListSelect();
  } catch (error) {
    setStatus(error.message || "Failed to load matchup data.", "error");
  }
});
