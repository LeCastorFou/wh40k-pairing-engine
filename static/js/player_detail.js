async function fetchPlayer(pid) {
  const res = await fetch(`/api/players/${pid}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load player");
  return data;
}

const FORCE_DISPOSITIONS = [
  "Priority assets",
  "Recon",
  "Take and hold",
  "Purge the foes",
  "Disruption"
];

const FACTIONS = [
  "Adepta Sororitas",
  "Adeptus Astartes (Space Marines)",
  "Adeptus Custodes",
  "Adeptus Mechanicus",
  "Aeldari",
  "Agents of the Imperium",
  "Astra Militarum",
  "Black Templars",
  "Blood Angels",
  "Chaos Daemons",
  "Chaos Knights",
  "Chaos Space Marines",
  "Dark Angels",
  "Death Guard",
  "Drukhari",
  "Emperor's Children",
  "Genestealer Cults",
  "Grey Knights",
  "Harlequins",
  "Imperial Knights",
  "Leagues of Votann",
  "Necrons",
  "Orks",
  "Space Wolves",
  "T'au Empire",
  "Thousand Sons",
  "Tyranids",
  "World Eaters",
  "Ynnari"
];

const DEPLOYMENTS = [
  "Dawn of War",
  "Search and Destroy",
  "Hammer and Anvil",
  "Tipping Point",
  "Crucible of Battle"
];

async function addMatch(pid, payload) {
  const res = await fetch(`/api/players/${pid}/matches`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to add match");
  return data;
}

async function deleteMatch(pid, matchId) {
  const res = await fetch(`/api/players/${pid}/matches/${matchId}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to delete match");
  return data;
}

function forceDispositionLabel(value) {
  return (value || "").toString().trim();
}

function localToday() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function populateOptionSelect(selectEl, values, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  selectEl.appendChild(empty);

  values.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  });
}

function populateForceDispositionSelect(selectEl, placeholder) {
  if (!selectEl) return;
  selectEl.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  selectEl.appendChild(empty);

  FORCE_DISPOSITIONS.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  });
}

function computeWinrate(hist) {
  const matches = Array.isArray(hist) ? hist : [];
  if (!matches.length) return { total: 0, winrate: null, wins:0, draws:0, losses:0 };

  let wins=0, draws=0, losses=0;
  matches.forEach(m => {
    const r = (m.result || "").toUpperCase();
    if (r === "WIN") wins++;
    else if (r === "DRAW") draws++;
    else if (r === "LOSS") losses++;
  });

  // Simple % win (draw not counted as win)
  const decisiveTotal = wins + losses;
  const winrate = decisiveTotal ? (wins / decisiveTotal) * 100 : null;
  const total = wins + draws + losses;
  return { total, winrate, wins, draws, losses };
}

function renderLists(player) {
  const box = document.getElementById("lists-box");
  const lists = player.lists || [];
  const def = player.default_index;

  if (!lists.length) {
    box.textContent = "No lists yet.";
    return;
  }

  box.innerHTML = "";
  lists.forEach((t, idx) => {
    const wrap = document.createElement("div");
    wrap.style.border = "1px solid rgba(255,255,255,0.08)";
    wrap.style.borderRadius = "12px";
    wrap.style.padding = ".6rem";
    wrap.style.marginBottom = ".6rem";
    wrap.style.background = "rgba(0,0,0,0.25)";

    const tag = document.createElement("div");
    tag.className = "pill";
    tag.style.marginBottom = ".5rem";
    const listName = (player.list_names?.[idx] || `List #${idx + 1}`).trim();
    const forceDisposition = forceDispositionLabel(player.list_force_dispositions?.[idx] || "");
    const titleParts = [(typeof def === "number" && def === idx) ? `Default list - ${listName}` : listName];
    if (forceDisposition) titleParts.push(forceDisposition);
    tag.textContent = titleParts.join(" · ");

    const pre = document.createElement("pre");
    pre.style.margin = "0";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontFamily = "monospace";
    pre.style.fontSize = ".85rem";
    pre.textContent = t;

    wrap.appendChild(tag);
    wrap.appendChild(pre);
    box.appendChild(wrap);
  });
}

function renderHistory(player) {
  const box = document.getElementById("history-box");
  const hist = (player.match_history || []).slice().reverse();

  if (!hist.length) {
    box.textContent = "No matches recorded yet.";
    return;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Date</th>
      <th>Faction</th>
      <th>Score</th>
      <th>T1</th>
      <th>Deployment</th>
      <th>Your dispo</th>
      <th>Opponent dispo</th>
      <th>Result</th>
      <th>Opponent</th>
      <th>Level</th>
      <th>Comment</th>
      <th></th>
    </tr>
  `;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  hist.forEach(m => {
    const tr = document.createElement("tr");

    const tdDate = document.createElement("td");
    tdDate.textContent = (m.date || "").replace("T"," ").slice(0,19) || "—";
    tdDate.className = "muted";
    tr.appendChild(tdDate);

    const tdFaction = document.createElement("td");
    tdFaction.textContent = m.faction || "—";
    tr.appendChild(tdFaction);

    const tdScore = document.createElement("td");
    tdScore.textContent = typeof m.score === "number" ? `${m.score}/20` : "—";
    tdScore.className = "muted";
    tr.appendChild(tdScore);

    const tdTurn = document.createElement("td");
    tdTurn.textContent = m.has_first_turn === true ? "We had T1" : (m.has_first_turn === false ? "Opponent T1" : "—");
    tdTurn.className = "muted";
    tr.appendChild(tdTurn);

    const tdDeployment = document.createElement("td");
    tdDeployment.textContent = m.deployment || "—";
    tdDeployment.className = "muted";
    tr.appendChild(tdDeployment);

    const tdPlayerForce = document.createElement("td");
    tdPlayerForce.textContent = forceDispositionLabel(m.player_force_disposition) || "—";
    tdPlayerForce.className = "muted";
    tr.appendChild(tdPlayerForce);

    const tdOpponentForce = document.createElement("td");
    tdOpponentForce.textContent = forceDispositionLabel(m.opponent_force_disposition) || "—";
    tdOpponentForce.className = "muted";
    tr.appendChild(tdOpponentForce);

    const tdRes = document.createElement("td");
    const r = (m.result || "").toUpperCase();
    tdRes.textContent = r || "—";
    tdRes.className = r === "WIN" ? "res-win" : (r === "DRAW" ? "res-draw" : "res-loss");
    tr.appendChild(tdRes);

    const tdOpponent = document.createElement("td");
    tdOpponent.textContent = m.opponent_name || m.event_name || "—";
    tdOpponent.className = "muted";
    tr.appendChild(tdOpponent);

    const tdLvl = document.createElement("td");
    tdLvl.textContent = typeof m.opponent_level === "number" ? `Level ${m.opponent_level}` : "—";
    tdLvl.className = "muted";
    tr.appendChild(tdLvl);

    const tdC = document.createElement("td");
    tdC.textContent = m.comment || "";
    tdC.className = "muted";
    tr.appendChild(tdC);

    const tdAct = document.createElement("td");
    tdAct.className = "row-actions";
    const del = document.createElement("button");
    del.className = "btn-ghost";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm("Delete this match?")) return;
      await deleteMatch(window.PLAYER_ID, m.id);
      await load();
    });
    tdAct.appendChild(del);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  box.innerHTML = "";
  box.appendChild(table);
}

async function load() {
  const err = document.getElementById("err");
  err.textContent = "";

  const player = await fetchPlayer(window.PLAYER_ID);

  document.getElementById("player-name").textContent = player.name || "Player";

  const stats = computeWinrate(player.match_history || []);
  document.getElementById("matches-pill").textContent = `Matches: ${stats.total}`;
  document.getElementById("winrate-pill").textContent =
    stats.winrate === null ? "Winrate: —" : `Winrate: ${stats.winrate.toFixed(1)}% (W${stats.wins}/D${stats.draws}/L${stats.losses})`;

  renderLists(player);
  renderHistory(player);
}

document.addEventListener("DOMContentLoaded", async () => {
  const factionSelect = document.getElementById("match-faction");
  const deploymentSelect = document.getElementById("match-deployment");
  const dateInput = document.getElementById("match-date");
  const playerForceSelect = document.getElementById("match-player-force-disposition");
  const opponentForceSelect = document.getElementById("match-opponent-force-disposition");
  populateOptionSelect(factionSelect, FACTIONS, "Faction encountered");
  populateOptionSelect(deploymentSelect, DEPLOYMENTS, "Deployment");
  populateForceDispositionSelect(playerForceSelect, "Your force disposition");
  populateForceDispositionSelect(opponentForceSelect, "Opponent force disposition");
  if (dateInput) dateInput.value = localToday();

  const btn = document.getElementById("add-match-btn");
  btn.addEventListener("click", async () => {
    const err = document.getElementById("err");
    err.textContent = "";

    const faction = factionSelect.value.trim();
    const date = dateInput.value;
    const score = parseInt(document.getElementById("match-score").value, 10);
    const has_first_turn_value = document.getElementById("match-first-turn").value;
    const deployment = deploymentSelect.value.trim();
    const player_force_disposition = playerForceSelect.value.trim();
    const opponent_force_disposition = opponentForceSelect.value.trim();
    const opponent_name = document.getElementById("match-opponent-name").value.trim();
    const opponent_level = parseInt(document.getElementById("match-level").value, 10);
    const comment = document.getElementById("match-comment").value.trim();

    if (!faction || !date || !Number.isInteger(score) || score < 0 || score > 20 || !has_first_turn_value || !deployment) {
      err.textContent = "Faction, date, score, turn 1, and deployment are required.";
      return;
    }

    try {
      await addMatch(window.PLAYER_ID, {
        faction,
        date,
        score,
        has_first_turn: has_first_turn_value,
        deployment,
        player_force_disposition,
        opponent_force_disposition,
        opponent_name,
        opponent_level,
        comment
      });
      factionSelect.value = "";
      dateInput.value = localToday();
      document.getElementById("match-score").value = "";
      document.getElementById("match-first-turn").value = "";
      deploymentSelect.value = "";
      playerForceSelect.value = "";
      opponentForceSelect.value = "";
      document.getElementById("match-opponent-name").value = "";
      document.getElementById("match-comment").value = "";
      await load();
    } catch (e) {
      err.textContent = e.message;
    }
  });

  await load();
});
