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

function createArmyCard(index) {
  const card = document.createElement("div");
  card.className = "army-card";

  const title = document.createElement("div");
  title.className = "army-title";
  title.textContent = `Opponent Slot #${index + 1}`;
  card.appendChild(title);

  const playerLabel = document.createElement("label");
  playerLabel.textContent = "Opponent Player";
  playerLabel.style.marginBottom = "0.2rem";
  card.appendChild(playerLabel);

  const playerInput = document.createElement("input");
  playerInput.type = "text";
  playerInput.className = "player-name-input";
  playerInput.dataset.index = index;
  playerInput.placeholder = "Ex: Paul Martin";
  card.appendChild(playerInput);

  // Faction select
  const factionLabel = document.createElement("label");
  factionLabel.textContent = "Codex / Faction";
  factionLabel.style.marginTop = "0.5rem";
  factionLabel.style.marginBottom = "0.2rem";
  card.appendChild(factionLabel);

  const select = document.createElement("select");
  select.className = "faction-select";
  select.dataset.index = index;

  const optEmpty = document.createElement("option");
  optEmpty.value = "";
  optEmpty.textContent = "— Select faction —";
  select.appendChild(optEmpty);

  FACTIONS.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    select.appendChild(opt);
  });

  card.appendChild(select);

  // List textarea
  const listLabel = document.createElement("label");
  listLabel.textContent = "List Text";
  listLabel.style.marginTop = "0.5rem";
  card.appendChild(listLabel);

  const textarea = document.createElement("textarea");
  textarea.className = "list-text";
  textarea.dataset.index = index;
  textarea.placeholder = "Paste the opponent's list here...";
  card.appendChild(textarea);

  return card;
}

async function saveGame() {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "";
  statusEl.className = "status";

  const opponentName = document.getElementById("opponent-name-input").value.trim();
  if (!opponentName) {
    statusEl.textContent = "Please enter an opponent name.";
    statusEl.classList.add("error");
    return;
  }

  const selects = Array.from(document.querySelectorAll(".faction-select"));
  const texts = Array.from(document.querySelectorAll(".list-text"));
  const playerNames = Array.from(document.querySelectorAll(".player-name-input"));

  const armies = [];
  const usedFactions = new Set();

  for (let i = 0; i < selects.length; i++) {
    const playerName = playerNames[i].value.trim();
    const faction = selects[i].value.trim();
    const listText = texts[i].value.trim();

    if (!playerName && !faction && !listText) {
      // Empty slot, ignore
      continue;
    }

    if (!playerName || !faction || !listText) {
      statusEl.textContent = `Slot #${i + 1}: you must enter an opponent player, choose a faction, and paste a list, or leave it fully empty.`;
      statusEl.classList.add("error");
      return;
    }

    if (usedFactions.has(faction)) {
      statusEl.textContent = `Faction "${faction}" is used more than once. Each codex must be unique.`;
      statusEl.classList.add("error");
      return;
    }

    usedFactions.add(faction);
    armies.push({ player_name: playerName, faction, list: listText });
  }

  if (armies.length === 0) {
    statusEl.textContent = "Please define at least one army.";
    statusEl.classList.add("error");
    return;
  }
  if (armies.length > 8) {
    statusEl.textContent = "Maximum is 8 armies.";
    statusEl.classList.add("error");
    return;
  }

  const payload = {
    opponent_name: opponentName,
    armies
  };

  const btn = document.getElementById("save-game-btn");
  btn.disabled = true;

  try {
    const res = await fetch("/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || "Error saving game.";
      statusEl.classList.add("error");
      return;
    }

    statusEl.textContent = "Game saved. The Machine Spirit is pleased.";
    statusEl.classList.add("success");

    // Optional: clear lists but keep opponent name
    // texts.forEach(t => t.value = "");

  } catch (err) {
    console.error(err);
    statusEl.textContent = "Network or server error.";
    statusEl.classList.add("error");
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("armies-container");

  // Create 8 slots
  for (let i = 0; i < 8; i++) {
    const card = createArmyCard(i);
    container.appendChild(card);
  }

  document.getElementById("save-game-btn").addEventListener("click", saveGame);
});
