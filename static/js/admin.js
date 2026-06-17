(function () {
  const adminEmail = (window.ADMIN_EMAIL || "").toLowerCase();
  let adminState = { teams: [], profiles: [] };

  function byId(id) {
    return document.getElementById(id);
  }

  function setStatus(id, message, type) {
    const el = byId(id);
    if (!el) return;
    el.textContent = message || "";
    el.className = `status${type ? ` ${type}` : ""}`;
  }

  async function requestJson(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Request failed.");
    }
    return data;
  }

  function metric(label, value) {
    const node = document.createElement("div");
    node.className = "metric";

    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    const valueNode = document.createElement("strong");
    valueNode.textContent = String(value);

    node.appendChild(labelNode);
    node.appendChild(valueNode);
    return node;
  }

  function renderSummary() {
    const container = byId("summary-grid");
    if (!container) return;

    const teams = adminState.teams || [];
    const profiles = adminState.profiles || [];
    const memberCount = teams.reduce((sum, team) => sum + Number(team.member_count || 0), 0);
    const gameCount = teams.reduce((sum, team) => sum + Number(team.game_count || 0), 0);

    container.innerHTML = "";
    container.appendChild(metric("Teams", teams.length));
    container.appendChild(metric("App Users", profiles.length));
    container.appendChild(metric("Memberships", memberCount));
    container.appendChild(metric("Games", gameCount));
  }

  function teamMeta(team) {
    const parts = [
      `${team.member_count || 0} members`,
      `${team.player_count || 0} players`,
      `${team.game_count || 0} games`,
      `${team.calendar_count || 0} calendar items`
    ];
    if (team.created_by_email) {
      parts.push(`created by ${team.created_by_email}`);
    }
    return parts.join(" | ");
  }

  function renderTeams() {
    const container = byId("teams-list");
    if (!container) return;
    container.innerHTML = "";

    if (!adminState.teams.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No teams found.";
      container.appendChild(empty);
      return;
    }

    adminState.teams.forEach((team) => {
      const row = document.createElement("div");
      row.className = "entity-row";
      row.dataset.teamId = String(team.id);

      const main = document.createElement("div");
      const title = document.createElement("div");
      title.className = "entity-title";

      const name = document.createElement("strong");
      name.textContent = team.name || "Unnamed team";
      const slug = document.createElement("span");
      slug.className = "muted";
      slug.textContent = team.slug ? `/${team.slug}` : "";
      title.appendChild(name);
      title.appendChild(slug);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = teamMeta(team);

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "entity-actions";

      const input = document.createElement("input");
      input.type = "text";
      input.value = team.name || "";
      input.setAttribute("aria-label", `Rename ${team.name || "team"}`);

      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "Rename";
      rename.addEventListener("click", () => renameTeam(team.id, input.value));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "secondary danger";
      del.textContent = "Delete";
      del.addEventListener("click", () => deleteTeam(team));

      actions.appendChild(input);
      actions.appendChild(rename);
      actions.appendChild(del);

      row.appendChild(main);
      row.appendChild(actions);
      container.appendChild(row);
    });
  }

  function membershipText(membership) {
    const bits = [
      membership.team_name || "Unnamed team",
      membership.role || "member"
    ];
    if (membership.player_name) {
      bits.push(`player: ${membership.player_name}`);
    }
    return bits.join(" | ");
  }

  function renderProfiles() {
    const container = byId("users-list");
    if (!container) return;
    container.innerHTML = "";

    if (!adminState.profiles.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No users found.";
      container.appendChild(empty);
      return;
    }

    adminState.profiles.forEach((profile) => {
      const isProtectedAdmin = (profile.email || "").toLowerCase() === adminEmail;
      const row = document.createElement("div");
      row.className = "entity-row";
      row.dataset.profileId = String(profile.id);

      const main = document.createElement("div");
      const title = document.createElement("div");
      title.className = "entity-title";

      const email = document.createElement("strong");
      email.textContent = profile.email || "No email";
      const name = document.createElement("span");
      name.className = "muted";
      name.textContent = profile.display_name ? profile.display_name : "No display name";
      title.appendChild(email);
      title.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${profile.membership_count || 0} memberships`;
      if (isProtectedAdmin) {
        meta.textContent += " | site admin";
      }

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "entity-actions";

      const input = document.createElement("input");
      input.type = "text";
      input.value = profile.display_name || "";
      input.placeholder = "Display name";
      input.setAttribute("aria-label", `Rename ${profile.email || "user"}`);

      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "Rename";
      rename.addEventListener("click", () => renameProfile(profile.id, input.value));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "secondary danger";
      del.textContent = "Delete User";
      del.disabled = isProtectedAdmin;
      del.title = isProtectedAdmin ? "The active site admin profile is protected." : "";
      del.addEventListener("click", () => deleteProfile(profile));

      actions.appendChild(input);
      actions.appendChild(rename);
      actions.appendChild(del);

      row.appendChild(main);
      row.appendChild(actions);

      const memberships = document.createElement("div");
      memberships.className = "membership-list";
      if (Array.isArray(profile.memberships) && profile.memberships.length) {
        profile.memberships.forEach((membership) => {
          const membershipRow = document.createElement("div");
          membershipRow.className = "membership-row";

          const label = document.createElement("span");
          label.textContent = membershipText(membership);

          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "secondary danger";
          remove.textContent = "Remove Access";
          remove.addEventListener("click", () => deleteMembership(profile, membership));

          membershipRow.appendChild(label);
          membershipRow.appendChild(remove);
          memberships.appendChild(membershipRow);
        });
      } else {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No team memberships.";
        memberships.appendChild(empty);
      }

      row.appendChild(memberships);
      container.appendChild(row);
    });
  }

  function render() {
    renderSummary();
    renderTeams();
    renderProfiles();
  }

  async function loadAdmin() {
    setStatus("teams-status", "Loading...");
    setStatus("users-status", "Loading...");
    try {
      adminState = await requestJson("/api/admin/overview");
      render();
      setStatus("teams-status", "");
      setStatus("users-status", "");
    } catch (err) {
      setStatus("teams-status", err.message || "Failed to load admin data.", "error");
      setStatus("users-status", err.message || "Failed to load admin data.", "error");
    }
  }

  async function renameTeam(teamId, name) {
    const nextName = (name || "").trim();
    if (!nextName) {
      setStatus("teams-status", "Team name is required.", "error");
      return;
    }
    setStatus("teams-status", "Renaming team...");
    try {
      await requestJson(`/api/admin/teams/${teamId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName })
      });
      setStatus("teams-status", "Team renamed.", "success");
      await loadAdmin();
    } catch (err) {
      setStatus("teams-status", err.message || "Could not rename team.", "error");
    }
  }

  async function deleteTeam(team) {
    const name = team.name || "this team";
    const confirmed = window.confirm(
      `Delete ${name}? This removes its players, games, calendar, settings, and memberships.`
    );
    if (!confirmed) return;

    setStatus("teams-status", "Deleting team...");
    try {
      await requestJson(`/api/admin/teams/${team.id}`, { method: "DELETE" });
      setStatus("teams-status", "Team deleted.", "success");
      await loadAdmin();
    } catch (err) {
      setStatus("teams-status", err.message || "Could not delete team.", "error");
    }
  }

  async function renameProfile(profileId, displayName) {
    const nextName = (displayName || "").trim();
    if (!nextName) {
      setStatus("users-status", "Display name is required.", "error");
      return;
    }
    setStatus("users-status", "Renaming user...");
    try {
      await requestJson(`/api/admin/profiles/${profileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: nextName })
      });
      setStatus("users-status", "User renamed.", "success");
      await loadAdmin();
    } catch (err) {
      setStatus("users-status", err.message || "Could not rename user.", "error");
    }
  }

  async function deleteProfile(profile) {
    const email = profile.email || "this user";
    const confirmed = window.confirm(
      `Delete app user ${email}? This removes their app profile and team access, but not their Supabase Auth account.`
    );
    if (!confirmed) return;

    setStatus("users-status", "Deleting user...");
    try {
      await requestJson(`/api/admin/profiles/${profile.id}`, { method: "DELETE" });
      setStatus("users-status", "User deleted.", "success");
      await loadAdmin();
    } catch (err) {
      setStatus("users-status", err.message || "Could not delete user.", "error");
    }
  }

  async function deleteMembership(profile, membership) {
    const teamName = membership.team_name || "this team";
    const userEmail = profile.email || "this user";
    const confirmed = window.confirm(`Remove ${userEmail} from ${teamName}?`);
    if (!confirmed) return;

    setStatus("users-status", "Removing access...");
    try {
      await requestJson(`/api/admin/memberships/${membership.id}`, { method: "DELETE" });
      setStatus("users-status", "Access removed.", "success");
      await loadAdmin();
    } catch (err) {
      setStatus("users-status", err.message || "Could not remove access.", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", loadAdmin);
})();
