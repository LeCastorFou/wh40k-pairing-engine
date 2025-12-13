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

    main.appendChild(opponent);
    main.appendChild(meta);

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
        title.textContent = `#${idx + 1} – ${army.faction || "Unknown Faction"}`;

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
