import { CONFIG } from './config.js';

const TOKEN_KEY = 'auth_token';

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

function parseJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}

// ── API helpers ─────────────────────────────────────────────────

export async function fetchSettings() {
  const token = getToken();
  const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.settings || {};
}

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
