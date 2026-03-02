import { CONFIG } from './config.js';

const TOKEN_KEY = 'auth_token';

/**
 * Initialise auth by checking for a token in the URL fragment.
 * Called once on page load.
 */
export function initAuth() {
  const hash = window.location.hash;
  if (hash.startsWith('#token=')) {
    const token = hash.slice('#token='.length);
    localStorage.setItem(TOKEN_KEY, token);
    // Clean the URL so the token isn't visible or bookmarkable
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// ── Cold-start readiness indicator ──────────────────────────────

let loadingDots = null;
let dotInterval = null;

function showLoadingDots() {
  if (loadingDots) return;
  document.querySelectorAll('.login-provider').forEach((b) => {
    b.disabled = true;
    b.classList.add('provider-loading');
  });
  loadingDots = document.createElement('span');
  loadingDots.id = 'loading-dots';
  loadingDots.textContent = '.';
  document.getElementById('user-bar').appendChild(loadingDots);
  let count = 1;
  dotInterval = setInterval(() => {
    count = (count % 3) + 1;
    loadingDots.textContent = '.'.repeat(count);
  }, 400);
}

function hideLoadingDots() {
  document.querySelectorAll('.login-provider').forEach((b) => {
    b.disabled = false;
    b.classList.remove('provider-loading');
  });
  if (dotInterval) { clearInterval(dotInterval); dotInterval = null; }
  if (loadingDots) { loadingDots.remove(); loadingDots = null; }
}

async function checkBackend() {
  try {
    const res = await fetch(`${CONFIG.apiUrl}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for the backend to be ready (handles cold starts from scale-to-zero).
 * Shows a loading indicator while polling.  Resolves when the backend
 * responds with a healthy status, or rejects after ~30 s.
 */
export async function ensureBackendReady() {
  showLoadingDots();
  const minDisplay = new Promise((r) => setTimeout(r, 800));

  if (await checkBackend()) {
    await minDisplay;
    hideLoadingDots();
    return;
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await checkBackend()) {
      hideLoadingDots();
      return;
    }
  }
  hideLoadingDots();
  throw new Error('Backend did not become ready in time');
}

/**
 * Redirect to the backend OAuth endpoint for the given provider.
 * @param {'github'|'google'|'microsoft'|'apple'} provider
 */
export async function login(provider) {
  // Keep picker visible with greyed-out buttons + dots while waking backend
  document.getElementById('login-picker').classList.remove('hidden');
  await ensureBackendReady();
  const redirectUri = encodeURIComponent(window.location.origin);
  window.location.href = `${CONFIG.apiUrl}/auth/${provider}?redirect_uri=${redirectUri}`;
}

/** Clear the stored token and reload. */
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem("user_display");
  window.location.reload();
}

/** Return the stored JWT, or null. */
export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/** Check whether a non-expired JWT is stored. */
export function isAuthenticated() {
  const token = getToken();
  if (!token) return false;
  try {
    const payload = parseJwtPayload(token);
    // exp is in seconds
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

/** Decode the JWT payload (no signature verification — that's the backend's job). */
export function getUser() {
  const token = getToken();
  if (!token) return null;
  try {
    return parseJwtPayload(token);
  } catch {
    return null;
  }
}

function parseJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}

// ── Local auth helpers ──────────────────────────────────────────

/**
 * Authenticate with username + password. Stores the returned JWT.
 * @returns {Promise<{token: string}>}
 */
export async function loginLocal(username, password) {
  await ensureBackendReady();
  const res = await fetch(`${CONFIG.apiUrl}/auth/local/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Login failed (${res.status})`);
  }
  const data = await res.json();
  localStorage.setItem(TOKEN_KEY, data.token);
  return data;
}

/**
 * Admin: create a local account.
 */
export async function createLocalAccount(username, password, displayName) {
  const token = getToken();
  const res = await fetch(`${CONFIG.apiUrl}/api/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ username, password, displayName: displayName || undefined }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create account (${res.status})`);
  }
  return res.json();
}

/**
 * Upload a profile picture (local users only).
 * @param {File} file
 */
export async function uploadProfilePicture(file) {
  const token = getToken();
  const form = new FormData();
  form.append('picture', file);
  const res = await fetch(`${CONFIG.apiUrl}/api/profile/picture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed (${res.status})`);
  }
  const data = await res.json();
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  return data;
}

/**
 * Fetch user settings from the backend.
 * @returns {Promise<object>}
 */
export async function fetchSettings() {
  const token = getToken();
  let res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 503) {
    await ensureBackendReady();
    res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.settings || {};
}

/**
 * Save user settings to the backend.
 * @param {object} settings
 * @returns {Promise<object>}
 */
export async function putSettings(settings) {
  const token = getToken();
  let res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ settings }),
  });

  if (res.status === 503) {
    await ensureBackendReady();
    res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ settings }),
    });
  }

  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/**
 * Remove profile picture (local users only).
 */
export async function deleteProfilePicture() {
  const token = getToken();
  const res = await fetch(`${CONFIG.apiUrl}/api/profile/picture`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Delete failed (${res.status})`);
  }
  const data = await res.json();
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  return data;
}
