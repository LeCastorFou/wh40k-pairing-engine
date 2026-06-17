(function () {
  const sessionState = window.APP_SESSION || {};

  const backdrop = document.getElementById("login-backdrop");
  const overlay = document.getElementById("locked-overlay");
  const openBtn = document.getElementById("open-login-btn");
  const closeBtn = document.getElementById("close-login-btn");
  const err = document.getElementById("login-error");
  const logoutBtn = document.getElementById("logout-btn");

  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const displayNameWrap = document.getElementById("display-name-wrap");
  const displayNameInput = document.getElementById("auth-display-name");
  const emailInput = document.getElementById("auth-email");
  const passwordInput = document.getElementById("auth-password");
  const authSubmitBtn = document.getElementById("auth-submit-btn");

  let authMode = "login";

  function isReady() {
    return !!(window.APP_SESSION || sessionState).ready;
  }

  function setError(message) {
    if (err) err.textContent = message || "";
  }

  function openModal() {
    if (!backdrop) return;
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    setError("");
  }

  function closeModal() {
    if (!backdrop) return;
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
  }

  function setAuthMode(mode) {
    authMode = mode === "signup" ? "signup" : "login";
    if (tabLogin) tabLogin.classList.toggle("active", authMode === "login");
    if (tabSignup) tabSignup.classList.toggle("active", authMode === "signup");
    if (displayNameWrap) displayNameWrap.classList.toggle("hidden", authMode !== "signup");
    if (authSubmitBtn) authSubmitBtn.textContent = authMode === "signup" ? "Create Account" : "Sign In";
  }

  async function submitAuth() {
    setError("");
    const email = (emailInput?.value || "").trim();
    const password = passwordInput?.value || "";
    const displayName = (displayNameInput?.value || "").trim();

    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    if (authMode === "signup" && !displayName) {
      setError("Display name is required.");
      return;
    }

    const endpoint = authMode === "signup" ? "/api/signup" : "/api/login";
    const payload = authMode === "signup"
      ? { email, password, display_name: displayName }
      : { email, password };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
      setError(data.error || "Authentication failed.");
      return;
    }

    if (res.status === 202) {
      setError(data.message || "Check your inbox to confirm the account.");
      return;
    }

    window.location.href = "/teams/access";
  }

  if (!isReady() && overlay) {
    overlay.style.display = "flex";
  }

  if (openBtn) openBtn.addEventListener("click", openModal);
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (backdrop) backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) closeModal();
  });

  if (tabLogin) tabLogin.addEventListener("click", () => setAuthMode("login"));
  if (tabSignup) tabSignup.addEventListener("click", () => setAuthMode("signup"));
  if (authSubmitBtn) authSubmitBtn.addEventListener("click", submitAuth);

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await fetch("/api/logout", { method: "POST" });
      window.location.reload();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
    if (event.key === "Enter" && backdrop && backdrop.style.display === "flex") {
      submitAuth();
    }
  });

  setAuthMode("login");
})();
