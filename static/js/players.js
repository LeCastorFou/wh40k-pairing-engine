const ACCESS = window.APP_ACCESS || {};
const IS_CAPTAIN = ACCESS.role === "captain";
const FORCE_DISPOSITIONS = [
  "Priority assets",
  "Recon",
  "Take and hold",
  "Purge the foes",
  "Disruption"
];

function canManagePlayer(playerId) {
  return true;
}

async function fetchPlayers() {
  const res = await fetch("/api/players");
  return await res.json();
}

async function createPlayers(names) {
  const res = await fetch("/api/players", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.error || "Error adding players";
    const error = new Error(message);
    error.payload = data;
    throw error;
  }
  return data;
}

async function deletePlayer(id) {
  const res = await fetch(`/api/players/${id}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Error deleting player");
  }
  return data;
}

async function addList(playerId, name, text, forceDisposition) {
  const res = await fetch(`/api/players/${playerId}/lists`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text, force_disposition: forceDisposition })
  });
  return await res.json();
}

async function updateList(playerId, index, name, text, forceDisposition) {
  const res = await fetch(`/api/players/${playerId}/lists/${index}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text, force_disposition: forceDisposition })
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

function forceDispositionLabel(value) {
  return FORCE_DISPOSITIONS.find(item => item.toLowerCase() === String(value || "").trim().toLowerCase()) || "";
}

function populateForceDispositionSelect(selectEl, selectedValue = "") {
  if (!selectEl) return;
  const selected = forceDispositionLabel(selectedValue);
  selectEl.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Select force disposition";
  selectEl.appendChild(empty);

  FORCE_DISPOSITIONS.forEach(value => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === selected;
    selectEl.appendChild(option);
  });
}

function setManagedPlayerStatus(message, tone = "") {
  const statusEl = getModalEl("managed-player-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = "status-text";
  if (tone) statusEl.classList.add(tone);
}

function parseManagedPlayerNames(rawValue) {
  if (typeof rawValue !== "string") return [];
  return rawValue
    .split(/[\n,;]+/)
    .map(name => name.trim())
    .filter(Boolean);
}

function closeListModal() {
  const overlay = getModalEl("list-modal");
  if (!overlay) return;
  overlay.classList.remove("visible");
}

function openListModal({ mode, playerId, listIndex = null, listName = "", listText = "", forceDisposition = "", playerName = "" }) {
  gModalState = { mode, playerId, listIndex };

  const overlay = getModalEl("list-modal");
  const title = getModalEl("list-modal-title");
  const subtitle = getModalEl("list-modal-subtitle");
  const nameInput = getModalEl("list-modal-name");
  const forceSelect = getModalEl("list-modal-force-disposition");
  const textInput = getModalEl("list-modal-text");
  const saveBtn = getModalEl("list-modal-save");

  if (!overlay || !title || !subtitle || !nameInput || !forceSelect || !textInput || !saveBtn) return;

  const isReadOnly = mode === "view";
  title.textContent = mode === "add" ? "Add List" : mode === "edit" ? "Edit List" : "View List";
  subtitle.textContent = playerName ? `Player: ${playerName}` : "";
  nameInput.value = listName;
  populateForceDispositionSelect(forceSelect, forceDisposition);
  textInput.value = listText;
  nameInput.readOnly = isReadOnly;
  forceSelect.disabled = isReadOnly;
  textInput.readOnly = isReadOnly;
  saveBtn.style.display = isReadOnly ? "none" : "inline-flex";

  overlay.classList.add("visible");
  (isReadOnly ? textInput : nameInput).focus();
}

async function saveListModal() {
  const { mode, playerId, listIndex } = gModalState;
  const nameInput = getModalEl("list-modal-name");
  const forceSelect = getModalEl("list-modal-force-disposition");
  const textInput = getModalEl("list-modal-text");
  const saveBtn = getModalEl("list-modal-save");
  if (!nameInput || !forceSelect || !textInput || !saveBtn) return;

  const name = nameInput.value.trim();
  const forceDisposition = forceSelect.value.trim();
  const text = textInput.value.trim();
  if (!name || !text) {
    alert("List name and list text are required.");
    return;
  }
  if (!forceDisposition) {
    alert("Force disposition is required.");
    return;
  }

  saveBtn.disabled = true;
  try {
    const data = mode === "add"
      ? await addList(playerId, name, text, forceDisposition)
      : await updateList(playerId, listIndex, name, text, forceDisposition);

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

  if (!Array.isArray(players) || players.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-text";
    empty.textContent = "No players yet. Add managed players above or wait for team members to join.";
    container.appendChild(empty);
    return;
  }

  players.forEach(player => {
    const card = document.createElement("div");
    card.className = "player-card";

    const header = document.createElement("div");
    header.className = "player-header";

    // Left side: name
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

    left.appendChild(title);

    // Right side: delete button
    header.appendChild(left);
    if (IS_CAPTAIN) {
      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "Delete player";
      deleteBtn.addEventListener("click", async () => {
        const confirmed = confirm(
          `Delete player "${player.name}"?\n\nThis also removes this player from game rosters, matrix cells, pairings, reports, and availability slots.`
        );
        if (!confirmed) return;

        deleteBtn.disabled = true;
        try {
          const result = await deletePlayer(player.id);
          const cleanup = result.cleanup || {};
          const updated = await fetchPlayers();
          renderPlayers(updated);
          setManagedPlayerStatus(
            `Deleted ${player.name}. Cleaned ${cleanup.games_touched || 0} game(s), ${cleanup.pairing_slots_cleared || 0} pairing slot(s), and ${cleanup.calendar_items_removed || 0} calendar item(s).`,
            "success"
          );
        } catch (error) {
          setManagedPlayerStatus(error.message || "Error deleting player.", "error");
          deleteBtn.disabled = false;
        }
      });
      header.appendChild(deleteBtn);
    }
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
        const currentForceDisposition = forceDispositionLabel(player.list_force_dispositions?.[idx] || "");

        const headerRow = document.createElement("div");
        headerRow.className = "list-meta";

        const nameTag = document.createElement("div");
        nameTag.style.fontWeight = "600";
        nameTag.style.letterSpacing = "0.04em";
        nameTag.textContent = currentName;
        headerRow.appendChild(nameTag);

        if (currentForceDisposition) {
          const forceBadge = document.createElement("span");
          forceBadge.className = "badge";
          forceBadge.textContent = currentForceDisposition;
          headerRow.appendChild(forceBadge);
        }

        if (player.default_index === idx) {
          const badge = document.createElement("span");
          badge.className = "badge";
          badge.textContent = "Default";
          headerRow.appendChild(badge);
        }

        listDiv.appendChild(headerRow);

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
            forceDisposition: currentForceDisposition,
            playerName: player.name
          });
        });

        meta.appendChild(viewBtn);
        if (canManagePlayer(player.id)) {
          const editBtn = document.createElement("button");
          editBtn.textContent = "Edit";
          editBtn.addEventListener("click", () => {
            openListModal({
              mode: "edit",
              playerId: player.id,
              listIndex: idx,
              listName: currentName,
              listText: text,
              forceDisposition: currentForceDisposition,
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

          meta.appendChild(editBtn);
          meta.appendChild(defaultLabel);
          meta.appendChild(deleteListBtn);
        }
        listDiv.appendChild(meta);

        listsDiv.appendChild(listDiv);
      });
    }

    if (canManagePlayer(player.id)) {
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
    }

    card.appendChild(listsDiv);
    container.appendChild(card);
  });
}

// ---------- INIT ----------

document.addEventListener("DOMContentLoaded", async () => {
  const modalOverlay = getModalEl("list-modal");
  const modalCloseBtn = getModalEl("list-modal-close");
  const modalCancelBtn = getModalEl("list-modal-cancel");
  const modalSaveBtn = getModalEl("list-modal-save");
  const managedPlayerForm = getModalEl("managed-player-form");
  const managedPlayerInput = getModalEl("managed-player-names");
  const managedPlayerSubmit = getModalEl("managed-player-submit");

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

  if (managedPlayerForm && managedPlayerInput && managedPlayerSubmit) {
    managedPlayerForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const names = parseManagedPlayerNames(managedPlayerInput.value);
      if (names.length === 0) {
        setManagedPlayerStatus("Enter at least one player name.", "error");
        managedPlayerInput.focus();
        return;
      }

      managedPlayerSubmit.disabled = true;
      setManagedPlayerStatus("Creating managed players...");

      try {
        const result = await createPlayers(names);
        const players = await fetchPlayers();
        renderPlayers(players);

        if ((result.created || []).length > 0) {
          managedPlayerInput.value = "";
        }

        const skippedNames = (result.skipped || []).map(entry => entry.name).filter(Boolean);
        let message = `Created ${(result.created || []).length} managed player(s).`;
        if (skippedNames.length > 0) {
          message += ` Skipped duplicates: ${skippedNames.join(", ")}.`;
        }
        setManagedPlayerStatus(message, "success");
      } catch (error) {
        const skippedNames = (error.payload?.skipped || []).map(entry => entry.name).filter(Boolean);
        let message = error.message || "Error adding players.";
        if (skippedNames.length > 0) {
          message += ` Skipped: ${skippedNames.join(", ")}.`;
        }
        setManagedPlayerStatus(message, "error");
      } finally {
        managedPlayerSubmit.disabled = false;
      }
    });
  }

  const players = await fetchPlayers();
  renderPlayers(players);
});
