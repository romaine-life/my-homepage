// Browser auth lives at auth.romaine.life. Anonymous users get one login
// option; after sign-in the returned auth user determines which bookmark tree
// loads. The old #token= path remains as a compatibility fallback for
// terminal-minted tokens.

const LEGACY_STORAGE_KEY = 'homepage_jwt';
const AUTH_BASE = 'https://auth.romaine.life';
const ENGINEERED_ARTS_EMAIL = 'n.romaine@engineeredarts.com';
const ENGINEERED_ARTS_DOMAIN = '@engineeredarts.com';
const LEGACY_BOOKMARK_SUBS = new Set(['nelson', 'nelson-ea', 'nelson-r1']);

let cachedAuthToken = null;

// Baked-deploy mode — SWA bypass hostname (work-computer access where
// *.romaine.life is blocked). Auth and API are inert; bookmarks are served
// from a static JSON file shipped alongside the frontend. checkAuth and
// fetchWhoami fake a nelson-r1 session so the authenticated UI renders
// normally. Edit/save buttons stay wired but silently fail on API calls —
// that's intentional per the deploy's read-only framing.
const IS_BAKED = typeof window !== 'undefined' &&
  window.location.hostname.endsWith('.azurestaticapps.net');

// Absorb `#token=<jwt>` on module load (runs once per page load).
(function absorbTokenFragment() {
  const match = window.location.hash.match(/#token=([A-Za-z0-9_\-.]+)/);
  if (match) {
    localStorage.setItem(LEGACY_STORAGE_KEY, match[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
})();

export function loginBookmark() {
  const callback = window.location.origin + window.location.pathname;
  return {
    name: 'Login',
    url: `${AUTH_BASE}/sign-in/microsoft?callbackURL=${encodeURIComponent(callback)}`,
    description: 'Sign in with auth.romaine.life',
  };
}

export function getToken() {
  if (isJwtUsable(cachedAuthToken)) return cachedAuthToken;
  cachedAuthToken = null;
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    return isJwtUsable(legacy) ? legacy : null;
  } catch {
    return null;
  }
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

function bookmarkSubForPayload(payload) {
  if (LEGACY_BOOKMARK_SUBS.has(payload.sub)) return payload.sub;

  const email = String(payload.email || '').trim().toLowerCase();
  if (email === ENGINEERED_ARTS_EMAIL || email.endsWith(ENGINEERED_ARTS_DOMAIN)) {
    return 'nelson-ea';
  }
  return 'nelson';
}

export async function checkAuth() {
  if (IS_BAKED) return true;
  const t = await getOrRefreshToken();
  if (!t) {
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup failures.
    }
    return false;
  }
  return true;
}

export async function fetchWhoami() {
  if (IS_BAKED) return { sub: 'nelson-r1', name: 'r1', email: 'gromaine@r1rcm.com' };
  const t = await getOrRefreshToken();
  if (!t) return null;
  const payload = parseJwt(t);
  if (!payload) return null;
  return {
    sub: bookmarkSubForPayload(payload),
    name: payload.name || null,
    email: payload.email || payload.sub,
    authSub: payload.sub,
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
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }

  const callback = window.location.origin + window.location.pathname;
  submitLogoutForm(callback);
}
