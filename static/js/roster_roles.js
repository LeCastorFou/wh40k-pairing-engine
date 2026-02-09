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

const ROLES = [
  { value: "defense", label: "Defense" },
  { value: "attack", label: "Attack" },
  { value: "blunt", label: "Blunt" }
];

let playersCache = [];
let roster = Array.from({ length: 8 }, () => null);

function factionColor(faction) {
  const str = (faction || "").toString();
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
}

function formatRole(role) {
  const match = ROLES.find(r => r.value === role);
  return match ? match.label : role;
}

function setStatus(message, type = "") {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

async function fetchPlayers() {
  try {
    const res = await fetch("/api/players");
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Unable to load players");
    }
    playersCache = Array.isArray(data) ? data : [];
    renderPlayers();
  } catch (err) {
    console.error(err);
    setStatus("Unable to load players.", "error");
  }
}

function sortPlayers(players) {
  return [...players].sort((a, b) => {
    const aActive = a.active ? 1 : 0;
    const bActive = b.active ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return (a.name || "").localeCompare(b.name || "");
  });
}

function buildArchetypeLabel(archetype) {
  const base = `${archetype.faction} — ${formatRole(archetype.role)}`;
  if (archetype.comment) {
    return `${base} • ${archetype.comment}`;
  }
  return base;
}

function createArchetypeChip(archetype, player, index) {
  const chip = document.createElement("div");
  chip.className = "archetype-item";
  const color = factionColor(archetype.faction);
  chip.style.borderColor = color;
  chip.style.boxShadow = `0 0 10px ${color}33`;
  chip.style.background = `linear-gradient(135deg, ${color}22, rgba(18,18,25,0.92))`;
  chip.draggable = true;
  chip.addEventListener("dragstart", e => {
    const payload = {
      player_id: player.id,
      player_name: player.name || `Player ${player.id}`,
      faction: archetype.faction,
      role: archetype.role,
      comment: archetype.comment || ""
    };
    e.dataTransfer.setData("application/json", JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  });

  const label = document.createElement("div");
  label.className = "archetype-text";
  label.textContent = buildArchetypeLabel(archetype);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "archetype-delete";
  delBtn.textContent = "×";
  delBtn.title = "Delete archetype";
  delBtn.addEventListener("click", async () => {
    await deleteArchetype(player.id, index);
  });

  chip.append(label, delBtn);
  return chip;
}

function createRoleSelect() {
  const select = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Role";
  select.appendChild(empty);
  ROLES.forEach(role => {
    const opt = document.createElement("option");
    opt.value = role.value;
    opt.textContent = role.label;
    select.appendChild(opt);
  });
  return select;
}

function createFactionSelect() {
  const select = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Faction";
  select.appendChild(empty);
  FACTIONS.forEach(faction => {
    const opt = document.createElement("option");
    opt.value = faction;
    opt.textContent = faction;
    select.appendChild(opt);
  });
  return select;
}

function renderPlayers() {
  const container = document.getElementById("players-container");
  container.innerHTML = "";

  const players = sortPlayers(playersCache);
  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "archetype-empty";
    empty.textContent = "No players found. Add players first.";
    container.appendChild(empty);
    return;
  }

  players.forEach(player => {
    const card = document.createElement("div");
    card.className = "player-card";

    const header = document.createElement("div");
    header.className = "player-header";

    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = player.name || `Player ${player.id}`;

    header.append(name);

    const archetypeList = document.createElement("div");
    archetypeList.className = "archetype-list";

    const archetypes = Array.isArray(player.archetypes) ? player.archetypes : [];
    if (!archetypes.length) {
      const empty = document.createElement("div");
      empty.className = "archetype-empty";
      empty.textContent = "No archetypes yet.";
      archetypeList.appendChild(empty);
    } else {
      archetypes.forEach((archetype, index) => {
        archetypeList.appendChild(createArchetypeChip(archetype, player, index));
      });
    }

    const form = document.createElement("form");
    form.className = "archetype-form";

    const factionSelect = createFactionSelect();
    const roleSelect = createRoleSelect();
    const commentInput = document.createElement("input");
    commentInput.type = "text";
    commentInput.placeholder = "Short comment";

    const addBtn = document.createElement("button");
    addBtn.type = "submit";
    addBtn.textContent = "Add";

    if (archetypes.length >= 3) {
      addBtn.disabled = true;
      addBtn.textContent = "Max 3";
    }

    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (archetypes.length >= 3) return;
      const faction = factionSelect.value.trim();
      const role = roleSelect.value.trim();
      const comment = commentInput.value.trim();

      if (!faction || !role) {
        setStatus("Pick a faction and a role before adding.", "error");
        return;
      }

      await addArchetype(player.id, { faction, role, comment });
    });

    form.append(factionSelect, roleSelect, commentInput, addBtn);

    card.append(header, archetypeList, form);
    container.appendChild(card);
  });
}

async function addArchetype(playerId, payload) {
  try {
    const res = await fetch(`/api/players/${playerId}/archetypes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Unable to add archetype");
    }
    setStatus("Archetype added.", "success");
    await fetchPlayers();
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  }
}

async function deleteArchetype(playerId, index) {
  try {
    const res = await fetch(`/api/players/${playerId}/archetypes/${index}`, {
      method: "DELETE"
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Unable to delete archetype");
    }
    setStatus("Archetype removed.", "success");
    await fetchPlayers();
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  }
}

function renderRoster() {
  const grid = document.getElementById("roster-grid");
  grid.innerHTML = "";

  roster.forEach((slot, index) => {
    const slotEl = document.createElement("div");
    slotEl.className = "roster-slot";
    slotEl.dataset.index = index;

    slotEl.addEventListener("dragover", e => {
      e.preventDefault();
      slotEl.classList.add("drag-over");
    });

    slotEl.addEventListener("dragleave", () => {
      slotEl.classList.remove("drag-over");
    });

    slotEl.addEventListener("drop", e => {
      e.preventDefault();
      slotEl.classList.remove("drag-over");
      const payload = e.dataTransfer.getData("application/json");
      if (!payload) return;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
      if (!data) return;

      const targetIndex = Number(slotEl.dataset.index);
      if (Number.isNaN(targetIndex)) return;

      if (typeof data.sourceSlot === "number") {
        if (data.sourceSlot !== targetIndex) {
          roster[data.sourceSlot] = null;
        }
        delete data.sourceSlot;
      }

      roster[targetIndex] = data;
      renderRoster();
    });

    const title = document.createElement("div");
    title.className = "slot-title";
    if (index === 0) {
      title.textContent = "DEF1";
    } else if (index === 1) {
      title.textContent = "DEF2";
    } else {
      title.textContent = `Slot ${index + 1}`;
    }

    slotEl.appendChild(title);

    if (!slot) {
      const empty = document.createElement("div");
      empty.className = "slot-empty";
      empty.textContent = "Drop archetype here";
      slotEl.appendChild(empty);
    } else {
      const item = document.createElement("div");
      item.className = "roster-item";
      const color = factionColor(slot.faction);
      item.style.borderColor = color;
      item.style.boxShadow = `0 0 12px ${color}33`;
      item.style.background = `linear-gradient(135deg, ${color}22, rgba(18,18,25,0.92))`;
      item.draggable = true;
      item.addEventListener("dragstart", e => {
        const payload = { ...slot, sourceSlot: index };
        e.dataTransfer.setData("application/json", JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "move";
      });

      const player = document.createElement("div");
      player.className = "roster-player";
      player.textContent = slot.player_name || `Player ${slot.player_id}`;

      const meta = document.createElement("div");
      meta.className = "roster-meta";
      const detail = `${slot.faction} — ${formatRole(slot.role)}`;
      meta.textContent = slot.comment ? `${detail} • ${slot.comment}` : detail;

      item.append(player, meta);
      slotEl.appendChild(item);

      const actions = document.createElement("div");
      actions.className = "slot-actions";

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "ghost";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => {
        roster[index] = null;
        renderRoster();
      });

      actions.appendChild(clearBtn);
      slotEl.appendChild(actions);
    }

    grid.appendChild(slotEl);
  });
}

function buildRosterMessage() {
  const lines = ["**Roster Proposal**"];
  roster.forEach((slot, index) => {
    if (!slot) {
      lines.push(`Slot ${index + 1}: —`);
      return;
    }
    const detail = `${slot.faction} (${formatRole(slot.role)})`;
    const comment = slot.comment ? ` — ${slot.comment}` : "";
    const name = slot.player_name || `Player ${slot.player_id}`;
    lines.push(`Slot ${index + 1}: ${name} — ${detail}${comment}`);
  });
  return lines.join("\n");
}

function saveRosterDraft() {
  const payload = {
    saved_at: new Date().toISOString(),
    roster
  };
  localStorage.setItem("pairingapp_roster_draft", JSON.stringify(payload));
  setStatus("Roster saved locally.", "success");
}

function loadRosterDraft() {
  const raw = localStorage.getItem("pairingapp_roster_draft");
  if (!raw) return;
  try {
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.roster) && data.roster.length === 8) {
      roster = data.roster.map(slot => {
        if (!slot || typeof slot !== "object") return null;
        if (!slot.faction || !slot.role || !slot.player_id) return null;
        return slot;
      });
      renderRoster();
    }
  } catch (err) {
    console.warn("Unable to load roster draft", err);
  }
}

async function sendRosterToDiscord() {
  if (!roster.some(slot => slot)) {
    setStatus("Roster is empty. Drag archetypes first.", "error");
    return;
  }
  try {
    const content = buildRosterMessage();
    const res = await fetch("/api/settings/send_message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to send roster");
    }
    setStatus("Roster sent to Discord.", "success");
  } catch (err) {
    console.error(err);
    setStatus(err.message, "error");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadRosterDraft();
  renderRoster();
  fetchPlayers();

  document.getElementById("save-roster-btn").addEventListener("click", saveRosterDraft);
  document.getElementById("clear-roster-btn").addEventListener("click", () => {
    roster = Array.from({ length: 8 }, () => null);
    renderRoster();
  });

  document.getElementById("send-discord-btn").addEventListener("click", sendRosterToDiscord);
});
