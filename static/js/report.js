let gRows = [];
let gSortKey = "avg_score";
let gSortDir = "desc"; // desc = best first

function fmtNum(x, digits = 2) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "—";
  return x.toFixed(digits);
}

function compare(a, b, key) {
  const va = a[key];
  const vb = b[key];

  // null/undefined last
  const aNil = (va === null || va === undefined || !Number.isFinite(va));
  const bNil = (vb === null || vb === undefined || !Number.isFinite(vb));
  if (aNil && bNil) return a.name.localeCompare(b.name);
  if (aNil) return 1;
  if (bNil) return -1;

  // numbers
  if (typeof va === "number" && typeof vb === "number") {
    return va - vb;
  }

  // strings
  return String(va).localeCompare(String(vb));
}

function sortRows() {
  const dir = (gSortDir === "asc") ? 1 : -1;
  gRows.sort((a, b) => dir * compare(a, b, gSortKey));
}

function setHeaderArrows() {
  document.querySelectorAll("th[data-key]").forEach(th => {
    const arrow = th.querySelector(".arrow");
    if (!arrow) return;
    if (th.dataset.key === gSortKey) {
      arrow.textContent = (gSortDir === "asc") ? "▲" : "▼";
    } else {
      arrow.textContent = "";
    }
  });
}

function renderTable() {
  sortRows();
  setHeaderArrows();

  const tbody = document.querySelector("#report-table tbody");
  tbody.innerHTML = "";

  gRows.forEach(row => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = row.name;
    tr.appendChild(tdName);

    const tdGames = document.createElement("td");
    tdGames.className = "num";
    tdGames.textContent = row.games_played ?? 0;
    tr.appendChild(tdGames);

    const tdAvg = document.createElement("td");
    tdAvg.className = "num";
    tdAvg.textContent = fmtNum(row.avg_score, 2);
    tr.appendChild(tdAvg);

    const tdDelta = document.createElement("td");
    tdDelta.className = "num";
    const d = row.avg_delta;
    tdDelta.textContent = (typeof d === "number") ? ((d >= 0 ? "+" : "") + fmtNum(d, 2)) : "—";
    if (typeof d === "number") tdDelta.classList.add(d >= 0 ? "delta-pos" : "delta-neg");
    tr.appendChild(tdDelta);

    const tdBtn = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "row-btn";
    btn.textContent = "View";
    btn.addEventListener("click", () => renderDetails(row));
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);

    tbody.appendChild(tr);
  });
}

function renderDetails(row) {
  const box = document.getElementById("details");
  box.style.display = "block";
  box.innerHTML = "";

  const title = document.createElement("h3");
  title.textContent = `${row.name} — games breakdown`;
  box.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "pill";
  meta.style.marginBottom = "0.75rem";
  meta.textContent = `Games: ${row.games_played} · Avg score: ${fmtNum(row.avg_score, 2)} · Avg delta: ${
    (typeof row.avg_delta === "number") ? ((row.avg_delta >= 0 ? "+" : "") + fmtNum(row.avg_delta, 2)) : "—"
  }`;
  box.appendChild(meta);

  const details = Array.isArray(row.details) ? row.details.slice() : [];
  details.sort((a, b) => (a.game_id || 0) - (b.game_id || 0) || (a.game_no || 0) - (b.game_no || 0));

  details.forEach(d => {
    const item = document.createElement("div");
    item.className = "details-item";

    const left = document.createElement("div");
    left.innerHTML = `
      <div><strong>Game #${d.game_id}</strong> <span class="muted">vs</span> <strong>${d.opponent || "Unknown"}</strong></div>
      <div class="muted">Board: ${d.scenario || "—"} · Round: ${d.game_no || "—"} · Opponent: ${d.faction || "—"}</div>
    `;

    const right = document.createElement("div");
    const exp = (typeof d.expected === "number") ? fmtNum(d.expected, 1) : "—";
    const real = (typeof d.real_score === "number") ? fmtNum(d.real_score, 0) : "—";
    const delta = (typeof d.delta === "number") ? ((d.delta >= 0 ? "+" : "") + fmtNum(d.delta, 1)) : "—";
    const deltaClass = (typeof d.delta === "number") ? (d.delta >= 0 ? "delta-pos" : "delta-neg") : "";
    right.innerHTML = `
      <div><span class="muted">State:</span> ${d.state || "—"}</div>
      <div><span class="muted">Expected:</span> ${exp}</div>
      <div><span class="muted">Real:</span> ${real}</div>
      <div class="${deltaClass}"><span class="muted">Δ:</span> ${delta}</div>
    `;

    item.appendChild(left);
    item.appendChild(right);
    box.appendChild(item);
  });

  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

async function loadReport() {
  const meta = document.getElementById("report-meta");
  meta.textContent = "Loading…";

  const res = await fetch("/api/report");
  const data = await res.json();
  if (!res.ok) {
    meta.textContent = data.error || "Failed to load report.";
    return;
  }

  gRows = data.players || [];
  meta.textContent = `Games analysed: ${data.games_count} · Players with results: ${gRows.length}`;

  renderTable();
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (gSortKey === key) {
        gSortDir = (gSortDir === "asc") ? "desc" : "asc";
      } else {
        gSortKey = key;
        gSortDir = (key === "name") ? "asc" : "desc";
      }
      renderTable();
    });
  });

  loadReport().catch(console.error);
});
