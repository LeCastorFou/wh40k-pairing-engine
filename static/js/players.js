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

async function addList(playerId, name, text) {
  const res = await fetch(`/api/players/${playerId}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text })
  });
  return await res.json();
}

async function updateList(playerId, index, name, text) {
  const res = await fetch(`/api/players/${playerId}/lists/${index}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text })
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

let gModalState = {
  mode: "view",
  playerId: null,
  listIndex: null
};

function getModalEl(id) {
  return document.getElementById(id);
}

function closeListModal() {
  const overlay = getModalEl("list-modal");
  if (!overlay) return;
  overlay.classList.remove("visible");
}

function openListModal({ mode, playerId, listIndex = null, listName = "", listText = "", playerName = "" }) {
  gModalState = { mode, playerId, listIndex };

  const overlay = getModalEl("list-modal");
  const title = getModalEl("list-modal-title");
  const subtitle = getModalEl("list-modal-subtitle");
  const nameInput = getModalEl("list-modal-name");
  const textInput = getModalEl("list-modal-text");
  const saveBtn = getModalEl("list-modal-save");

  if (!overlay || !title || !subtitle || !nameInput || !textInput || !saveBtn) return;

  const isReadOnly = mode === "view";
  title.textContent = mode === "add" ? "Add List" : mode === "edit" ? "Edit List" : "View List";
  subtitle.textContent = playerName ? `Player: ${playerName}` : "";
  nameInput.value = listName;
  textInput.value = listText;
  nameInput.readOnly = isReadOnly;
  textInput.readOnly = isReadOnly;
  saveBtn.style.display = isReadOnly ? "none" : "inline-flex";

  overlay.classList.add("visible");
  (isReadOnly ? textInput : nameInput).focus();
}

async function saveListModal() {
  const { mode, playerId, listIndex } = gModalState;
  const nameInput = getModalEl("list-modal-name");
  const textInput = getModalEl("list-modal-text");
  const saveBtn = getModalEl("list-modal-save");
  if (!nameInput || !textInput || !saveBtn) return;

  const name = nameInput.value.trim();
  const text = textInput.value.trim();
  if (!name || !text) {
    alert("List name and list text are required.");
    return;
  }

  saveBtn.disabled = true;
  try {
    const data = mode === "add"
      ? await addList(playerId, name, text)
      : await updateList(playerId, listIndex, name, text);

    if (data?.error) {
      alert(data.error);
      return;
    }

    closeListModal();
    const updated = await fetchPlayers();
    renderPlayers(updated);
  } finally {
    saveBtn.disabled = false;
  }
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
        if (player.default_index === idx) listDiv.classList.add("is-default");

        const currentName = (player.list_names?.[idx] || `List #${idx + 1}`).trim();

        const headerRow = document.createElement("div");
        headerRow.className = "list-meta";

        const nameTag = document.createElement("div");
        nameTag.style.fontWeight = "600";
        nameTag.style.letterSpacing = "0.04em";
        nameTag.textContent = currentName;
        headerRow.appendChild(nameTag);

        if (player.default_index === idx) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "Default";
          headerRow.appendChild(badge);
        }

        listDiv.appendChild(headerRow);

        const helper = document.createElement("div");
        helper.className = "empty-text";
        helper.style.fontStyle = "normal";
        helper.style.marginBottom = "0.55rem";
        helper.textContent = "List text is handled in a separate modal for readability.";
        listDiv.appendChild(helper);

        const meta = document.createElement("div");
        meta.className = "list-meta";

        const viewBtn = document.createElement("button");
        viewBtn.textContent = "View";
        viewBtn.addEventListener("click", () => {
          openListModal({
            mode: "view",
            playerId: player.id,
            listIndex: idx,
            listName: currentName,
            listText: text,
            playerName: player.name
          });
        });

        const editBtn = document.createElement("button");
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          openListModal({
            mode: "edit",
            playerId: player.id,
            listIndex: idx,
            listName: currentName,
            listText: text,
            playerName: player.name
          });
        });

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

        meta.appendChild(viewBtn);
        meta.appendChild(editBtn);
        meta.appendChild(defaultLabel);
        meta.appendChild(deleteListBtn);
        listDiv.appendChild(meta);

        listsDiv.appendChild(listDiv);
      });
    }

    const addListBtn = document.createElement("button");
    addListBtn.textContent = "Add list";
    addListBtn.addEventListener("click", async () => {
      openListModal({
        mode: "add",
        playerId: player.id,
        listName: "",
        listText: "",
        playerName: player.name
      });
    });

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

  const modalOverlay = getModalEl("list-modal");
  const modalCloseBtn = getModalEl("list-modal-close");
  const modalCancelBtn = getModalEl("list-modal-cancel");
  const modalSaveBtn = getModalEl("list-modal-save");

  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeListModal);
  if (modalCancelBtn) modalCancelBtn.addEventListener("click", closeListModal);
  if (modalSaveBtn) modalSaveBtn.addEventListener("click", saveListModal);
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (event) => {
      if (event.target === modalOverlay) closeListModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeListModal();
  });

  const players = await fetchPlayers();
  renderPlayers(players);
});
