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

async function sendTestMessage() {
  const statusEl = document.getElementById("status");
  try {
    const res = await fetch("/api/settings/test_webhook", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send test message");
    if (statusEl) {
      statusEl.textContent = "Test message sent.";
      statusEl.className = "status success";
    }
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = err.message || "Failed to send test message.";
      statusEl.className = "status error";
    }
  }
}

async function sendCustomMessage(content) {
  const statusEl = document.getElementById("custom-status");
  try {
    const res = await fetch("/api/settings/send_message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send message");
    if (statusEl) {
      statusEl.textContent = "Message sent.";
      statusEl.className = "status success";
    }
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = err.message || "Failed to send message.";
      statusEl.className = "status error";
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("webhook-form");
  const input = document.getElementById("discord-webhook");
  const clearBtn = document.getElementById("clear-webhook-btn");
  const testBtn = document.getElementById("test-webhook-btn");
  const statusEl = document.getElementById("status");
  const customInput = document.getElementById("custom-message");
  const sendCustomBtn = document.getElementById("send-custom-btn");
  const customStatus = document.getElementById("custom-status");

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

  if (testBtn) {
    testBtn.addEventListener("click", async () => {
      if (statusEl) {
        statusEl.textContent = "Sending test message...";
        statusEl.className = "status";
      }
      await sendTestMessage();
    });
  }

  if (sendCustomBtn) {
    sendCustomBtn.addEventListener("click", async () => {
      if (!customInput) return;
      const content = (customInput.value || "").trim();
      if (!content) {
        if (customStatus) {
          customStatus.textContent = "Please write a message first.";
          customStatus.className = "status error";
        }
        return;
      }
      if (customStatus) {
        customStatus.textContent = "Sending message...";
        customStatus.className = "status";
      }
      await sendCustomMessage(content);
    });
  }
});
