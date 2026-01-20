async function loadSettings() {
  const statusEl = document.getElementById("status");
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) throw new Error("Failed to load settings");
    const data = await res.json();
    const input = document.getElementById("discord-webhook");
    if (input) input.value = data.discord_webhook || "";
    if (statusEl) statusEl.textContent = "";
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = "Failed to load settings.";
      statusEl.className = "status error";
    }
  }
}

async function saveSettings(webhook) {
  const statusEl = document.getElementById("status");
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discord_webhook: webhook })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save settings");
    if (statusEl) {
      statusEl.textContent = "Webhook saved.";
      statusEl.className = "status success";
    }
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = err.message || "Failed to save webhook.";
      statusEl.className = "status error";
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("webhook-form");
  const input = document.getElementById("discord-webhook");
  const clearBtn = document.getElementById("clear-webhook-btn");
  const statusEl = document.getElementById("status");

  await loadSettings();

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input) return;
      if (statusEl) {
        statusEl.textContent = "Saving...";
        statusEl.className = "status";
      }
      saveSettings((input.value || "").trim());
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!input) return;
      input.value = "";
      if (statusEl) {
        statusEl.textContent = "Cleared. Click save to apply.";
        statusEl.className = "status";
      }
    });
  }
});
