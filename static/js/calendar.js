(() => {
  const calendarEl = document.getElementById("fc-calendar");
  const statusEl = document.getElementById("calendar-status");
  const formStatusEl = document.getElementById("form-status");

  const typeEl = document.getElementById("slot-type");
  const playerEl = document.getElementById("slot-player");
  const gameEl = document.getElementById("slot-game");
  const dateEl = document.getElementById("slot-date");
  const startEl = document.getElementById("slot-start");
  const endEl = document.getElementById("slot-end");
  const titleEl = document.getElementById("slot-title");
  const notesEl = document.getElementById("slot-notes");
  const saveBtn = document.getElementById("slot-save");
  const clearBtn = document.getElementById("slot-clear");

  const filterAvailability = document.getElementById("filter-availability");
  const filterPairing = document.getElementById("filter-pairing");
  const filterGame = document.getElementById("filter-game");

  let gPlayers = [];
  let gGames = [];
  let gGamesSelectable = [];
  let gItems = [];
  let gCalendar = null;

  function dateKeyLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function timeKeyLocal(d) {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${min}`;
  }

  function playerColor(player) {
    const seed = String(player.id || player.name || "player");
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    }
    const hue = hash % 360;
    return `hsl(${hue}, 60%, 65%)`;
  }

  function getCssVar(name, fallback) {
    const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return val || fallback;
  }

  const pairingColor = getCssVar("--pairing", "#ba68c8");
  const gameColor = getCssVar("--game", "#ffd166");

  function filteredItems() {
    return gItems.filter(item => {
      if (item.type === "availability" && !filterAvailability.checked) return false;
      if (item.type === "pairing" && !filterPairing.checked) return false;
      if (item.type === "game" && !filterGame.checked) return false;
      return true;
    });
  }

  function isGameFinished(game) {
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
    return scores.length === 8;
  }

  function populatePlayers() {
    playerEl.innerHTML = "";
    const teamOpt = document.createElement("option");
    teamOpt.value = "";
    teamOpt.textContent = "Whole team";
    playerEl.appendChild(teamOpt);

    gPlayers.forEach(p => {
      const opt = document.createElement("option");
      opt.value = String(p.id);
      opt.textContent = p.name;
      playerEl.appendChild(opt);
    });
  }

  function populateGames() {
    gameEl.innerHTML = "";
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "No linked game";
    gameEl.appendChild(noneOpt);

    gGamesSelectable.forEach(g => {
      const opt = document.createElement("option");
      opt.value = String(g.id);
      opt.textContent = `#${g.id} vs ${g.opponent_name}`;
      gameEl.appendChild(opt);
    });
  }

  function updateFormFields() {
    const type = typeEl.value;
    const isAvailability = type === "availability";
    const isGame = type === "game";

    playerEl.disabled = !isAvailability;
    if (!isAvailability) {
      playerEl.value = "";
    }
    gameEl.disabled = !isGame;
    if (!isGame) {
      gameEl.value = "";
    }
  }

  function mapItemToEvent(item) {
    const event = {
      id: String(item.id),
      title: item.title || "Slot",
      start: item.start,
      end: item.end,
      allDay: false,
      extendedProps: {
        type: item.type,
        player_id: item.player_id,
        game_id: item.game_id
      }
    };

    if (item.type === "pairing") {
      event.backgroundColor = pairingColor;
      event.borderColor = pairingColor;
      event.textColor = "#111";
    }

    if (item.type === "game") {
      event.backgroundColor = gameColor;
      event.borderColor = gameColor;
      event.textColor = "#111";
    }

    if (item.type === "availability" && item.player_id) {
      const player = gPlayers.find(p => p.id === item.player_id);
      if (player) {
        const color = playerColor(player);
        event.backgroundColor = color;
        event.borderColor = color;
        event.textColor = "#111";
        event.title = `${player.name} · ${event.title}`;
      }
    }

    return event;
  }

  function refreshCalendarEvents() {
    if (!gCalendar) return;
    const events = filteredItems().map(mapItemToEvent);
    gCalendar.removeAllEvents();
    gCalendar.addEventSource(events);
    statusEl.textContent = `${events.length} slot(s) visible.`;
  }

  function initCalendar() {
    gCalendar = new FullCalendar.Calendar(calendarEl, {
      initialView: "timeGridWeek",
      headerToolbar: {
        left: "prev,next today",
        center: "title",
        right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek"
      },
      height: "auto",
      nowIndicator: true,
      selectable: true,
      selectMirror: true,
      unselectAuto: false,
      slotMinTime: "12:00:00",
      slotMaxTime: "24:00:00",
      select: (info) => {
        const start = info.start;
        const end = info.end || info.start;
        const isAllDay = info.allDay;

        const dateStr = dateKeyLocal(start);
        dateEl.value = dateStr;

        if (isAllDay) {
          startEl.value = "12:00";
          endEl.value = "14:00";
        } else {
          startEl.value = timeKeyLocal(start);
          endEl.value = timeKeyLocal(end);
        }

        formStatusEl.textContent = "Slot prefilled from calendar selection.";
      },
      eventClick: async (info) => {
        const id = info.event.id;
        if (!id) return;
        if (!confirm("Delete this slot?")) return;
        await deleteItem(id);
      }
    });

    gCalendar.render();
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
      let detail = "";
      try {
        const data = await res.json();
        detail = data.error || JSON.stringify(data);
      } catch (e) {
        detail = res.statusText;
      }
      throw new Error(detail || "Request failed");
    }
    return res.json();
  }

  async function loadData() {
    try {
      const [players, games, items] = await Promise.all([
        fetchJson("/api/players"),
        fetchJson("/api/games"),
        fetchJson("/api/calendar")
      ]);
      gPlayers = players;
      gGames = games;
      gGamesSelectable = games.filter(g => !isGameFinished(g));
      gItems = items;
      populatePlayers();
      populateGames();
      refreshCalendarEvents();
    } catch (err) {
      statusEl.textContent = `Error loading calendar: ${err.message}`;
    }
  }

  async function saveItem() {
    formStatusEl.textContent = "";
    const type = typeEl.value;
    const date = dateEl.value;
    const startTime = startEl.value;
    const endTime = endEl.value;

    if (!date || !startTime || !endTime) {
      formStatusEl.textContent = "Please choose a date, start time, and end time.";
      return;
    }

    if (type === "availability" && !playerEl.value) {
      formStatusEl.textContent = "Select a player for availability slots.";
      return;
    }

    const startIso = `${date}T${startTime}`;
    const endIso = `${date}T${endTime}`;

    const payload = {
      type,
      title: titleEl.value.trim(),
      notes: notesEl.value.trim(),
      start: startIso,
      end: endIso,
      player_id: playerEl.value ? Number(playerEl.value) : null,
      game_id: gameEl.value ? Number(gameEl.value) : null
    };

    try {
      await fetchJson("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      formStatusEl.textContent = "Slot saved.";
      titleEl.value = "";
      notesEl.value = "";
      if (gCalendar) gCalendar.unselect();
      await loadData();
    } catch (err) {
      formStatusEl.textContent = err.message;
    }
  }

  async function deleteItem(id) {
    try {
      await fetchJson(`/api/calendar/${id}`, { method: "DELETE" });
      await loadData();
    } catch (err) {
      statusEl.textContent = `Delete failed: ${err.message}`;
    }
  }

  function clearForm() {
    typeEl.value = "availability";
    playerEl.value = "";
    gameEl.value = "";
    titleEl.value = "";
    notesEl.value = "";
    startEl.value = "12:00";
    endEl.value = "14:00";
    formStatusEl.textContent = "";
    updateFormFields();
    if (gCalendar) gCalendar.unselect();
  }

  filterAvailability.addEventListener("change", refreshCalendarEvents);
  filterPairing.addEventListener("change", refreshCalendarEvents);
  filterGame.addEventListener("change", refreshCalendarEvents);

  typeEl.addEventListener("change", updateFormFields);
  saveBtn.addEventListener("click", saveItem);
  clearBtn.addEventListener("click", clearForm);

  updateFormFields();
  initCalendar();
  loadData();
})();
