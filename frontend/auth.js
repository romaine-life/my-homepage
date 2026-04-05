import { CONFIG } from './config.js';

/** Clear the auth cookie by requesting the API to expire it, then reload. */
export function logout() {
  // The cookie is HttpOnly so we can't clear it from JS.
  // Navigate to an API endpoint that clears it and redirects back.
  window.location.href = `${CONFIG.apiUrl}/auth/logout`;
}

/**
 * Check if the user is authenticated by making a lightweight API call.
 * The HttpOnly cookie is sent automatically — JS never touches the token.
 */
export async function checkAuth() {
  try {
    const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── API helpers ─────────────────────────────────────────────────

export async function fetchSettings() {
  const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data.settings || {};
}

export async function putSettings(settings) {
  const res = await fetch(`${CONFIG.apiUrl}/api/settings`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
