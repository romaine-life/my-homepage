// Client-side-only auth. The terminal (`at homepagelogin`) mints a JWT with
// the shared api-jwt-signing-secret, then opens the browser at
//   https://homepage.romaine.life/#token=<jwt>
// This module absorbs the fragment on load, stashes the JWT in localStorage,
// scrubs the URL, and hands it out as a Bearer header on API calls. No
// cookie, no /auth/* endpoints — fzt-frontend.romaine.life only verifies.

const STORAGE_KEY = 'homepage_jwt';

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
    localStorage.setItem(STORAGE_KEY, match[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
})();

export function getToken() {
  return localStorage.getItem(STORAGE_KEY);
}

export function authHeader() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function parseJwt(t) {
  try {
    return JSON.parse(atob(t.split('.')[1]));
  } catch {
    return null;
  }
}

export async function checkAuth() {
  if (IS_BAKED) return true;
  const t = getToken();
  if (!t) return false;
  const payload = parseJwt(t);
  if (!payload) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    localStorage.removeItem(STORAGE_KEY);
    return false;
  }
  return true;
}

export async function fetchWhoami() {
  if (IS_BAKED) return { sub: 'nelson-r1', name: 'r1', email: 'gromaine@r1rcm.com' };
  const t = getToken();
  if (!t) return null;
  const payload = parseJwt(t);
  if (!payload) return null;
  return {
    sub: payload.sub,
    name: payload.name || null,
    email: payload.email || payload.sub,
  };
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
  window.location.reload();
}
