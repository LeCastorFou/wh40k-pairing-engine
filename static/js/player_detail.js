async function fetchPlayer(pid) {
  const res = await fetch(`/api/players/${pid}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load player");
  return data;
}

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
  const total = wins + draws + losses;
  const winrate = total ? (wins / total) * 100 : null;
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
    tag.textContent = (typeof def === "number" && def === idx) ? "Default list" : `List #${idx+1}`;

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
      <th>Result</th>
      <th>Opponent</th>
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

    const tdRes = document.createElement("td");
    const r = (m.result || "").toUpperCase();
    tdRes.textContent = r || "—";
    tdRes.className = r === "WIN" ? "res-win" : (r === "DRAW" ? "res-draw" : "res-loss");
    tr.appendChild(tdRes);

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
  const btn = document.getElementById("add-match-btn");
  btn.addEventListener("click", async () => {
    const err = document.getElementById("err");
    err.textContent = "";

    const faction = document.getElementById("match-faction").value.trim();
    const result = document.getElementById("match-result").value;
    const opponent_level = parseInt(document.getElementById("match-level").value, 10);
    const comment = document.getElementById("match-comment").value.trim();

    try {
      await addMatch(window.PLAYER_ID, { faction, result, opponent_level, comment });
      document.getElementById("match-faction").value = "";
      document.getElementById("match-comment").value = "";
      await load();
    } catch (e) {
      err.textContent = e.message;
    }
  });

  await load();
});
