async function fetchPlayers() {
  const res = await fetch("/api/players");
  return await res.json();
}

function updateActiveCounter(players) {
  const el = document.getElementById("active-counter");
  if (!el) return;
  const count = players.filter(p => p.active).length;
  el.textContent = `Active: ${count} / 8`;
}

async function addPlayer(name) {
  const res = await fetch("/api/players", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) {
    let msg = "Error adding player";
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
      if (err.details) msg += ` (${err.details})`;
    } catch (_) {}
    alert(msg);
    return null;
  }
  return await res.json();
}

async function setPlayerActive(playerId, active) {
  const res = await fetch(`/api/players/${playerId}/active`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to update active");
  return data;
}




async function deletePlayer(id) {
  await fetch(`/api/players/${id}`, { method: "DELETE" });
}

async function addList(playerId, text) {
  const res = await fetch(`/api/players/${playerId}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  return await res.json();
}


async function deleteList(playerId, index) {
  const res = await fetch(`/api/players/${playerId}/lists/${index}`, {
    method: "DELETE"
  });
  return await res.json();
}

async function setDefaultList(playerId, index) {
  const res = await fetch(`/api/players/${playerId}/default_list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ index })
  });
  return await res.json();
}

// ---------- RENDERING ----------

function renderPlayers(players) {
  const container = document.getElementById("players-container");
  container.innerHTML = "";

  updateActiveCounter(players);

  players.forEach(player => {
    const card = document.createElement("div");
    card.className = "player-card";

    const header = document.createElement("div");
    header.className = "player-header";

    // Left side: name + active checkbox
    const left = document.createElement("div");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.style.gap = "0.6rem";

    const title = document.createElement("a");
    title.href = `/players/${player.id}`;
    title.textContent = player.name;
    title.style.color = "#f5f5f5";
    title.style.textDecoration = "none";
    title.style.fontFamily = "Cinzel, serif";
    title.style.letterSpacing = "0.12em";
    title.style.textTransform = "uppercase";
    title.addEventListener("mouseenter", () => title.style.textDecoration = "underline");
    title.addEventListener("mouseleave", () => title.style.textDecoration = "none");

    // ✅ ACTIVE CHECKBOX (this is the key)
    const activeLabel = document.createElement("label");
    activeLabel.style.display = "inline-flex";
    activeLabel.style.alignItems = "center";
    activeLabel.style.gap = "0.35rem";
    activeLabel.style.fontSize = "0.75rem";
    activeLabel.style.color = "#bbb";
    activeLabel.style.textTransform = "uppercase";
    activeLabel.style.letterSpacing = "0.12em";
    activeLabel.style.cursor = "pointer";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!player.active;

    // Disable if already 8 active and this player is not active
    const activeCount = players.filter(p => p.active).length;
    if (!player.active && activeCount >= 8) {
      checkbox.disabled = true;
      activeLabel.title = "Only 8 players can be active.";
    }

    checkbox.addEventListener("change", async () => {
      const wantActive = checkbox.checked;

      // UI-side guard (backend also enforces)
      const freshActiveCount = players.filter(p => p.active).length;
      if (wantActive && freshActiveCount >= 8) {
        checkbox.checked = false;
        alert("Only 8 players can be active.");
        return;
      }

      try {
        const updated = await setPlayerActive(player.id, wantActive);
        // update local array
        player.active = updated.active;

        // Re-fetch to refresh disabled states + counter
        const updatedPlayers = await fetchPlayers();
        renderPlayers(updatedPlayers);
      } catch (e) {
        checkbox.checked = !wantActive;
        alert(e.message);
      }
    });

    activeLabel.appendChild(checkbox);
    activeLabel.appendChild(document.createTextNode("Active"));

    left.appendChild(title);
    left.appendChild(activeLabel);

    // Right side: delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete player";
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Delete player "${player.name}"?`)) return;
      await deletePlayer(player.id);
      const updated = await fetchPlayers();
      renderPlayers(updated);
    });

    header.appendChild(left);
    header.appendChild(deleteBtn);
    card.appendChild(header);

    // Lists
    const listsDiv = document.createElement("div");
    listsDiv.className = "lists";

    const listsTitle = document.createElement("h4");
    listsTitle.textContent = "Army lists";
    listsDiv.appendChild(listsTitle);

    if (!player.lists || player.lists.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No lists yet.";
      listsDiv.appendChild(empty);
    } else {
      player.lists.forEach((text, idx) => {
        const listDiv = document.createElement("div");
        listDiv.className = "list-item";

        const wrap = document.createElement("div");
        wrap.className = "pre-expand";

        const pre = document.createElement("pre");
        pre.textContent = text;

        wrap.appendChild(pre);

        // only add toggle if it’s long-ish
        if ((text || "").length > 100) {
          const toggle = document.createElement("div");
          toggle.className = "pre-toggle";
          toggle.textContent = "Show more";
          toggle.addEventListener("click", () => {
            const expanded = wrap.classList.toggle("expanded");
            toggle.textContent = expanded ? "Show less" : "Show more";
          });
          wrap.appendChild(toggle);
        }

        listDiv.appendChild(wrap);


        const meta = document.createElement("div");
        meta.className = "list-meta";

        const defaultLabel = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `default-list-${player.id}`;
        radio.checked = player.default_index === idx;
        radio.addEventListener("change", async () => {
          await setDefaultList(player.id, idx);
          const updated = await fetchPlayers();
          renderPlayers(updated);
        });
        defaultLabel.appendChild(radio);
        defaultLabel.appendChild(document.createTextNode(" Default"));

        const deleteListBtn = document.createElement("button");
        deleteListBtn.textContent = "Delete list";
        deleteListBtn.addEventListener("click", async () => {
          if (!confirm("Delete this list?")) return;
          await deleteList(player.id, idx);
          const updated = await fetchPlayers();
          renderPlayers(updated);
        });

        meta.appendChild(defaultLabel);
        meta.appendChild(deleteListBtn);
        listDiv.appendChild(meta);

        listsDiv.appendChild(listDiv);
      });
    }

    // Add list form
    const textarea = document.createElement("textarea");
    textarea.placeholder = "Paste or type an army list here...";

    const addListBtn = document.createElement("button");
    addListBtn.textContent = "Add list";

    addListBtn.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text) return;
      await addList(player.id, text);
      textarea.value = "";
      const updated = await fetchPlayers();
      renderPlayers(updated);
    });

    listsDiv.appendChild(textarea);
    listsDiv.appendChild(addListBtn);

    card.appendChild(listsDiv);
    container.appendChild(card);
  });
}

// ---------- INIT ----------

document.addEventListener("DOMContentLoaded", async () => {
  const addBtn = document.getElementById("add-player-btn");
  const nameInput = document.getElementById("player-name-input");

  addBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await addPlayer(name);
    nameInput.value = "";
    const players = await fetchPlayers();
    renderPlayers(players);
  });

  const players = await fetchPlayers();
  renderPlayers(players);
});
