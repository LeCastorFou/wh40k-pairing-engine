(function () {
  const teamStatus = document.getElementById("team-status");
  const formStatus = document.getElementById("form-status");
  const accountLogoutBtn = document.getElementById("account-logout-btn");

  const tabJoinTeam = document.getElementById("tab-join-team");
  const tabCreateTeam = document.getElementById("tab-create-team");
  const joinTeamFields = document.getElementById("join-team-fields");
  const createTeamFields = document.getElementById("create-team-fields");
  const teamSelect = document.getElementById("team-select");
  const teamRole = document.getElementById("team-role");
  const teamPasswordInput = document.getElementById("team-password");
  const joinTeamBtn = document.getElementById("join-team-btn");
  const newTeamNameInput = document.getElementById("new-team-name");
  const newTeamPasswordInput = document.getElementById("new-team-password");
  const createTeamBtn = document.getElementById("create-team-btn");

  let teamMode = "join";

  function setStatus(target, message, type) {
    if (!target) return;
    target.textContent = message || "";
    target.className = `status${type ? ` ${type}` : ""}`;
  }

  function setTeamMode(mode) {
    teamMode = mode === "create" ? "create" : "join";
    if (tabJoinTeam) tabJoinTeam.classList.toggle("active", teamMode === "join");
    if (tabCreateTeam) tabCreateTeam.classList.toggle("active", teamMode === "create");
    if (joinTeamFields) joinTeamFields.classList.toggle("hidden", teamMode !== "join");
    if (createTeamFields) createTeamFields.classList.toggle("hidden", teamMode !== "create");
    setStatus(formStatus, "");
  }

  async function populateTeams() {
    if (!teamSelect) return;
    setStatus(formStatus, "Loading teams...");
    try {
      const res = await fetch("/api/teams/discover");
      const data = await res.json().catch(() => []);
      teamSelect.innerHTML = "";

      if (!res.ok) {
        throw new Error(data.error || "Could not load teams.");
      }

      if (!Array.isArray(data) || data.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "No team found. Create a team instead.";
        teamSelect.appendChild(option);
        setStatus(formStatus, "");
        return;
      }

      data.forEach((team) => {
        const option = document.createElement("option");
        option.value = String(team.id);
        option.textContent = `${team.name} (${team.slug})`;
        teamSelect.appendChild(option);
      });
      setStatus(formStatus, "");
    } catch (err) {
      setStatus(formStatus, err.message || "Could not load teams.", "error");
    }
  }

  async function selectMembership(membershipId) {
    setStatus(teamStatus, "Opening team...");
    const res = await fetch("/api/teams/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membership_id: membershipId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(teamStatus, data.error || "Could not switch team.", "error");
      return;
    }
    window.location.href = "/";
  }

  async function submitJoinTeam() {
    setStatus(formStatus, "");
    const teamId = Number(teamSelect?.value || "");
    const role = teamRole?.value || "captain";
    const teamPassword = teamPasswordInput?.value || "";

    if (!teamId) {
      setStatus(formStatus, "Choose a team first.", "error");
      return;
    }
    if (!teamPassword) {
      setStatus(formStatus, "Team password is required.", "error");
      return;
    }

    setStatus(formStatus, "Joining team...");
    const res = await fetch("/api/teams/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team_id: teamId,
        role,
        team_password: teamPassword
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(formStatus, data.error || "Could not join the team.", "error");
      return;
    }
    window.location.href = "/";
  }

  async function submitCreateTeam() {
    setStatus(formStatus, "");
    const teamName = (newTeamNameInput?.value || "").trim();
    const teamPassword = newTeamPasswordInput?.value || "";

    if (!teamName || !teamPassword) {
      setStatus(formStatus, "Team name and team password are required.", "error");
      return;
    }

    setStatus(formStatus, "Creating team...");
    const res = await fetch("/api/teams/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team_name: teamName,
        team_password: teamPassword,
        role: "captain"
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(formStatus, data.error || "Could not create the team.", "error");
      return;
    }
    window.location.href = "/";
  }

  document.querySelectorAll(".switch-team-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const membershipId = Number(button.dataset.membershipId || "");
      if (!membershipId) {
        setStatus(teamStatus, "Could not read this team access.", "error");
        return;
      }
      selectMembership(membershipId);
    });
  });

  if (tabJoinTeam) tabJoinTeam.addEventListener("click", () => setTeamMode("join"));
  if (tabCreateTeam) tabCreateTeam.addEventListener("click", () => setTeamMode("create"));
  if (joinTeamBtn) joinTeamBtn.addEventListener("click", submitJoinTeam);
  if (createTeamBtn) createTeamBtn.addEventListener("click", submitCreateTeam);

  if (accountLogoutBtn) {
    accountLogoutBtn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      window.location.href = "/";
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (teamMode === "create") {
      submitCreateTeam();
    } else {
      submitJoinTeam();
    }
  });

  setTeamMode("join");
  populateTeams();
})();
