import { CONFIG } from './config.js';

const TOKEN_KEY = 'auth_token';

// ── MSAL setup (loaded via CDN in index.html) ──────────────────

let msalInstance = null;
let msalReady = null;

function initMsal() {
  if (!window.msal) return;
  try {
    msalInstance = new msal.PublicClientApplication({
      auth: {
        clientId: CONFIG.microsoftClientId,
        authority: 'https://login.microsoftonline.com/common',
        redirectUri: window.location.origin,
      },
    });
    msalReady = msalInstance.initialize();
  } catch (err) {
    console.error('MSAL initialization failed:', err);
    msalInstance = null;
  }
}

/**
 * Initialise auth: handle MSAL redirect response, then check for stored token.
 * Returns true if the user ended up authenticated.
 */
export async function initAuth() {
  initMsal();

  if (msalInstance) {
    try {
      await msalReady;
      const response = await msalInstance.handleRedirectPromise();
      if (response?.idToken) {
        // Exchange Microsoft ID token for app JWT
        const res = await fetch(`${CONFIG.apiUrl}/auth/microsoft/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.idToken }),
        });
        if (res.ok) {
          const data = await res.json();
          localStorage.setItem(TOKEN_KEY, data.token);
        }
      }
    } catch (err) {
      console.error('MSAL redirect handling failed:', err);
    }
  }

  return isAuthenticated();
}

/**
 * Start Microsoft login via MSAL redirect.
 */
export async function loginWithMicrosoft() {
  if (!msalInstance) return;
  try {
    await msalReady;
    await msalInstance.loginRedirect({
      scopes: ['openid', 'profile', 'email'],
      prompt: 'select_account',
    });
  } catch (err) {
    console.error('MSAL loginRedirect failed:', err);
  }
}

/** Clear the stored token and reload. */
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem('user_display');
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

// ── API helpers ─────────────────────────────────────────────────

/**
 * Fetch user settings from the backend.
 */
export async function fetchSettings() {
  const token = getToken();
  const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.settings || {};
}

/**
 * Save user settings to the backend.
 */
export async function putSettings(settings) {
  const token = getToken();
  const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
