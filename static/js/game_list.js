async function fetchGames() {
  const res = await fetch("/api/games");
  if (!res.ok) {
    throw new Error("Failed to fetch games");
  }
  return await res.json();
}

async function deleteGame(id) {
  const res = await fetch(`/api/games/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete game");
  }
}

function renderGames(games) {
  const container = document.getElementById("games-container");
  const statusEl = document.getElementById("status");
  container.innerHTML = "";

  if (!games.length) {
    statusEl.textContent = "No games saved yet. The galaxy awaits new conflicts.";
    statusEl.className = "status empty";
    return;
  }

  statusEl.textContent = `${games.length} game(s) recorded.`;
  statusEl.className = "status";

  const computeGameStatus = (game) => {
    const pairings = Array.isArray(game.pairings) ? game.pairings : [];
    const scores = pairings
      .map(p => {
        if (typeof p?.real_score === "number") return p.real_score;
        if (typeof p?.real_score === "string" && p.real_score.trim() !== "") {
          const parsed = parseInt(p.real_score, 10);
          return Number.isNaN(parsed) ? null : parsed;
        }
        return null;
      })
      .filter(v => typeof v === "number");

    const done = scores.length === 8;
    let resultLabel = "—";
    if (done) {
      const total = scores.reduce((sum, v) => sum + v, 0);
      if (total < 75) resultLabel = "LOST";
      else if (total <= 85) resultLabel = "DRAW";
      else resultLabel = "WON";
    }
    return { done, resultLabel };
  };

  games.forEach(game => {
    const card = document.createElement("div");
    card.className = "game-card";

    const header = document.createElement("div");
    header.className = "game-header";

    const main = document.createElement("div");
    main.className = "game-main";

    const opponent = document.createElement("div");
    opponent.className = "game-opponent";
    opponent.textContent = game.opponent_name || "Unknown Opponent";

    const meta = document.createElement("div");
    meta.className = "game-meta";
    const armiesCount = Array.isArray(game.armies) ? game.armies.length : 0;
    meta.textContent = `${armiesCount} codex · ${game.created_at || "Unknown date"}`;

    const badges = document.createElement("div");
    badges.className = "game-badges";

    const { done, resultLabel } = computeGameStatus(game);

    const statusBadge = document.createElement("span");
    statusBadge.className = `badge ${done ? "badge-done" : "badge-pending"}`;
    statusBadge.textContent = done ? "DONE" : "PENDING";

    const resultBadge = document.createElement("span");
    let resultClass = "badge-muted";
    if (done) {
      if (resultLabel === "WON") resultClass = "badge-win";
      else if (resultLabel === "LOST") resultClass = "badge-loss";
      else resultClass = "badge-draw";
    }
    resultBadge.className = `badge ${resultClass}`;
    resultBadge.textContent = resultLabel;

    badges.appendChild(statusBadge);
    badges.appendChild(resultBadge);

    main.appendChild(opponent);
    main.appendChild(meta);
    main.appendChild(badges);

    const actions = document.createElement("div");
    actions.className = "game-actions";

    const matrixBtn = document.createElement("button");
    matrixBtn.className = "secondary";
    matrixBtn.textContent = "Filling matrices";
    matrixBtn.addEventListener("click", () => {
    window.location.href = `/games/${game.id}/matrix`;
    });

    // NEW: Fight button
    const fightBtn = document.createElement("button");
    fightBtn.className = "secondary";
    fightBtn.textContent = "Fight";
    fightBtn.addEventListener("click", () => {
    window.location.href = `/games/${game.id}/fight`;
    });

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "secondary";
    toggleBtn.textContent = "Show Armies";

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";

    actions.appendChild(matrixBtn);
    actions.appendChild(fightBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(deleteBtn);


    header.appendChild(main);
    header.appendChild(actions);

    card.appendChild(header);

    const armiesDiv = document.createElement("div");
    armiesDiv.className = "armies";

    if (Array.isArray(game.armies) && game.armies.length) {
      game.armies.forEach((army, idx) => {
        const item = document.createElement("div");
        item.className = "army-item";

        const title = document.createElement("div");
        title.className = "army-title";
        const playerName = (army.player_name || "").trim();
        const faction = army.faction || "Unknown Faction";
        title.textContent = playerName
          ? `#${idx + 1} – ${playerName} · ${faction}`
          : `#${idx + 1} – ${faction}`;

        const pre = document.createElement("pre");
        pre.textContent = army.list || "";

        item.appendChild(title);
        item.appendChild(pre);
        armiesDiv.appendChild(item);
      });
    } else {
      const empty = document.createElement("div");
      empty.className = "army-item";
      empty.textContent = "No armies recorded for this game.";
      armiesDiv.appendChild(empty);
    }

    card.appendChild(armiesDiv);

    toggleBtn.addEventListener("click", () => {
      const visible = armiesDiv.classList.toggle("visible");
      toggleBtn.textContent = visible ? "Hide Armies" : "Show Armies";
    });

    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete game vs "${game.opponent_name}"?`)) return;
      try {
        await deleteGame(game.id);
        const updated = await fetchGames();
        renderGames(updated);
      } catch (err) {
        alert(err.message || "Error deleting game");
      }
    });

    container.appendChild(card);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  try {
    const games = await fetchGames();
    renderGames(games);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Failed to load games from the data-vault.";
    statusEl.className = "status error";
  }
});
