// Browser auth lives at auth.romaine.life. Anonymous users get one login
// option; after sign-in the auth.romaine.life JWT's opaque `sub` keys the
// bookmark tree (`<sub>-bookmarks`). There is no legacy terminal-minted
// `#token=` path and no email->slug mapping — the token's `sub` is the
// identity, full stop.

const AUTH_BASE = 'https://auth.romaine.life';

let cachedAuthToken = null;

// Baked-deploy mode — SWA bypass hostname (work-computer access where
// *.romaine.life is blocked). Auth is inert; bookmarks are served from a
// static JSON file shipped alongside the frontend, so the faked session's
// sub never drives a fetch.
const IS_BAKED = typeof window !== 'undefined' &&
  window.location.hostname.endsWith('.azurestaticapps.net');

export function loginBookmark() {
  const callback = window.location.origin + window.location.pathname;
  return {
    name: 'Login',
    url: `${AUTH_BASE}/sign-in/microsoft?callbackURL=${encodeURIComponent(callback)}&prompt=select_account`,
    description: 'Sign in with auth.romaine.life',
  };
}

export function getToken() {
  if (isJwtUsable(cachedAuthToken)) return cachedAuthToken;
  cachedAuthToken = null;
  return null;
}

export async function authHeader() {
  const t = await getOrRefreshToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function parseJwt(t) {
  try {
    const encoded = t.split('.')[1];
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4 || 4)), '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function isJwtUsable(t) {
  if (!t) return false;
  const payload = parseJwt(t);
  if (!payload) return false;
  return !payload.exp || payload.exp > Math.floor(Date.now() / 1000) + 30;
}

async function fetchAuthToken() {
  const res = await fetch(`${AUTH_BASE}/api/auth/token`, {
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data && typeof data.token === 'string' ? data.token : null;
}

async function getOrRefreshToken() {
  const current = getToken();
  if (current) return current;

  try {
    const token = await fetchAuthToken();
    if (!isJwtUsable(token)) return null;
    cachedAuthToken = token;
    return token;
  } catch {
    return null;
  }
}

export async function checkAuth() {
  if (IS_BAKED) return true;
  return Boolean(await getOrRefreshToken());
}

export async function fetchWhoami() {
  if (IS_BAKED) return { sub: 'baked', name: 'baked', email: 'baked@local' };
  const t = await getOrRefreshToken();
  if (!t) return null;
  const payload = parseJwt(t);
  if (!payload) return null;
  return {
    sub: payload.sub,
    name: payload.name || null,
    email: payload.email || payload.sub,
  };
}

function submitLogoutForm(callback) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `${AUTH_BASE}/sign-out`;

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'callbackURL';
  input.value = callback;
  form.appendChild(input);

  document.body.appendChild(form);
  form.submit();
}

export function logout() {
  cachedAuthToken = null;
  const callback = window.location.origin + window.location.pathname;
  submitLogoutForm(callback);
}
