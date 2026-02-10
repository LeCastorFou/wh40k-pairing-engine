(() => {
  const DAY_COUNT = 14;
  const START_HOUR = 12;
  const END_HOUR = 24;
  const ROW_H = 28;

  const headerEl = document.getElementById("calendar-header");
  const bodyEl = document.getElementById("calendar-body");
  const agendaEl = document.getElementById("agenda-list");
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
  let gItems = [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const maxDay = new Date(today);
  maxDay.setDate(today.getDate() + (DAY_COUNT - 1));

  const formatter = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  });

  const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  });

  function dateKey(date) {
    return date.toISOString().slice(0, 10);
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

  function isoFromDateTime(dateStr, timeStr) {
    return `${dateStr}T${timeStr}`;
  }

  function clampDateInput() {
    dateEl.min = dateKey(today);
    dateEl.max = dateKey(maxDay);
    dateEl.value = dateKey(today);
    startEl.value = "12:00";
    endEl.value = "14:00";
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

    gGames.forEach(g => {
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

  function buildCalendarFrame() {
    headerEl.innerHTML = "";
    bodyEl.innerHTML = "";

    const headerBlank = document.createElement("div");
    headerBlank.textContent = "Time";
    headerEl.appendChild(headerBlank);

    const startDate = new Date(today);
    for (let i = 0; i < DAY_COUNT; i++) {
      const day = new Date(startDate);
      day.setDate(startDate.getDate() + i);
      const cell = document.createElement("div");
      cell.textContent = formatter.format(day);
      cell.dataset.day = dateKey(day);
      headerEl.appendChild(cell);
    }

    const timeCol = document.createElement("div");
    timeCol.className = "time-col";
    for (let hour = START_HOUR; hour <= END_HOUR; hour++) {
      const label = document.createElement("div");
      label.className = "time-label";
      const labelTime = new Date(today);
      labelTime.setHours(hour, 0, 0, 0);
      label.textContent = timeFormatter.format(labelTime);
      const offset = (hour - START_HOUR) * 2 * ROW_H;
      label.style.top = `${offset}px`;
      timeCol.appendChild(label);
    }
    bodyEl.appendChild(timeCol);

    for (let i = 0; i < DAY_COUNT; i++) {
      const day = new Date(startDate);
      day.setDate(startDate.getDate() + i);
      const dayCol = document.createElement("div");
      dayCol.className = "day-col";
      dayCol.dataset.day = dateKey(day);
      bodyEl.appendChild(dayCol);
    }
  }

  function minutesFromStart(date) {
    return (date.getHours() * 60 + date.getMinutes()) - (START_HOUR * 60);
  }

  function assignLanes(items) {
    const lanes = [];
    const assigned = [];
    items.forEach(item => {
      const start = new Date(item.start);
      const end = new Date(item.end);
      let laneIndex = -1;
      for (let i = 0; i < lanes.length; i++) {
        if (start >= lanes[i]) {
          laneIndex = i;
          lanes[i] = end;
          break;
        }
      }
      if (laneIndex === -1) {
        lanes.push(end);
        laneIndex = lanes.length - 1;
      }
      assigned.push({ item, lane: laneIndex });
    });
    return { assigned, laneCount: lanes.length || 1 };
  }

  function filteredItems() {
    return gItems.filter(item => {
      if (item.type === "availability" && !filterAvailability.checked) return false;
      if (item.type === "pairing" && !filterPairing.checked) return false;
      if (item.type === "game" && !filterGame.checked) return false;
      return true;
    });
  }

  function renderCalendar() {
    buildCalendarFrame();

    const playersMap = new Map(gPlayers.map(p => [p.id, p]));
    const gamesMap = new Map(gGames.map(g => [g.id, g]));
    const items = filteredItems();

    const dayMap = new Map();
    items.forEach(item => {
      const day = item.start.slice(0, 10);
      if (!dayMap.has(day)) dayMap.set(day, []);
      dayMap.get(day).push(item);
    });

    for (const [day, itemsForDay] of dayMap.entries()) {
      const dayCol = bodyEl.querySelector(`.day-col[data-day="${day}"]`);
      if (!dayCol) continue;

      const sorted = itemsForDay.slice().sort((a, b) => a.start.localeCompare(b.start));
      const { assigned, laneCount } = assignLanes(sorted);
      const gap = 6;
      const widthPct = 100 / laneCount;

      assigned.forEach(({ item, lane }) => {
        const start = new Date(item.start);
        const end = new Date(item.end);
        const top = minutesFromStart(start) / 30 * ROW_H;
        const height = Math.max(1, (end - start) / (30 * 60 * 1000) * ROW_H);
        const card = document.createElement("div");
        card.className = `event-item ${item.type}`;
        card.style.top = `${top}px`;
        card.style.height = `${height}px`;
        card.style.left = `calc(${lane * widthPct}% + ${gap / 2}px)`;
        card.style.width = `calc(${widthPct}% - ${gap}px)`;

        let meta = [];
        if (item.type === "availability" && item.player_id) {
          const player = playersMap.get(item.player_id);
          if (player) {
            const color = playerColor(player);
            card.style.setProperty("--event-bg", color);
            card.style.borderColor = "rgba(0,0,0,0.35)";
            meta.push(player.name);
          }
        }
        if (item.type === "pairing") {
          card.style.setProperty("--event-bg", "var(--pairing)");
        }
        if (item.type === "game") {
          card.style.setProperty("--event-bg", "var(--game)");
        }
        if (item.type === "game" && item.game_id) {
          const game = gamesMap.get(item.game_id);
          if (game) meta.push(`#${game.id} vs ${game.opponent_name}`);
        }

        const timeLabel = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
        meta.unshift(timeLabel);

        card.innerHTML = `
          <div class="event-title">${item.title || "Slot"}</div>
          <div class="event-meta">${meta.join(" · ")}</div>
        `;

        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (!confirm("Delete this slot?")) return;
          await deleteItem(item.id);
        });
        card.appendChild(delBtn);

        dayCol.appendChild(card);
      });
    }

    const startLabel = formatter.format(today);
    const endLabel = formatter.format(maxDay);
    statusEl.textContent = `Showing ${startLabel} to ${endLabel} (${DAY_COUNT} days).`;
  }

  function renderAgenda() {
    const playersMap = new Map(gPlayers.map(p => [p.id, p]));
    const gamesMap = new Map(gGames.map(g => [g.id, g]));
    const items = filteredItems().slice().sort((a, b) => a.start.localeCompare(b.start));

    const byDay = new Map();
    items.forEach(item => {
      const day = item.start.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    });

    agendaEl.innerHTML = "";

    for (let i = 0; i < DAY_COUNT; i++) {
      const dayDate = new Date(today);
      dayDate.setDate(today.getDate() + i);
      const key = dateKey(dayDate);
      const dayItems = byDay.get(key) || [];

      const block = document.createElement("div");
      block.className = "list-day";
      block.innerHTML = `<h3>${formatter.format(dayDate)}</h3>`;

      if (!dayItems.length) {
        const empty = document.createElement("div");
        empty.className = "list-item";
        empty.textContent = "No slots yet.";
        block.appendChild(empty);
      } else {
        dayItems.forEach(item => {
          const start = new Date(item.start);
          const end = new Date(item.end);
          const timeLabel = `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

          let detail = [];
          if (item.type === "availability" && item.player_id) {
            const player = playersMap.get(item.player_id);
            if (player) detail.push(player.name);
          }
          if (item.type === "game" && item.game_id) {
            const game = gamesMap.get(item.game_id);
            if (game) detail.push(`#${game.id} vs ${game.opponent_name}`);
          }

          const row = document.createElement("div");
          row.className = "list-item";
          if (item.type === "availability" && item.player_id) {
            const player = playersMap.get(item.player_id);
            if (player) {
              const color = playerColor(player);
              row.style.border = `1px solid ${color}`;
            }
          }
          const typeLabel = item.type === "game" ? "planned match" : item.type;
          row.innerHTML = `
            <div>
              <div>${item.title || "Slot"}</div>
              <div style="color: var(--muted); font-size:0.7rem;">${timeLabel}${detail.length ? " · " + detail.join(" · ") : ""}</div>
            </div>
            <span class="pill ${item.type}">${typeLabel}</span>
          `;
          if (item.type === "availability" && item.player_id) {
            const player = playersMap.get(item.player_id);
            if (player) {
              const pill = row.querySelector(".pill");
              pill.style.background = playerColor(player);
              pill.style.color = "#111";
            }
          }
          block.appendChild(row);
        });
      }

      agendaEl.appendChild(block);
    }
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
      gItems = items;
      populatePlayers();
      populateGames();
      renderCalendar();
      renderAgenda();
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

    const startIso = isoFromDateTime(date, startTime);
    const endIso = isoFromDateTime(date, endTime);

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
  }

  filterAvailability.addEventListener("change", () => {
    renderCalendar();
    renderAgenda();
  });
  filterPairing.addEventListener("change", () => {
    renderCalendar();
    renderAgenda();
  });
  filterGame.addEventListener("change", () => {
    renderCalendar();
    renderAgenda();
  });

  typeEl.addEventListener("change", updateFormFields);
  saveBtn.addEventListener("click", saveItem);
  clearBtn.addEventListener("click", clearForm);

  clampDateInput();
  updateFormFields();
  loadData();
})();
