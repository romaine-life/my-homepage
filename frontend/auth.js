// Browser auth lives at auth.romaine.life. Anonymous users can select a
// homepage profile, sign in with Microsoft there, and return here with the
// shared .romaine.life auth session. We then fetch an RS256 bearer JWT from
// auth.romaine.life and hand it to fzt-frontend. The old #token= path is kept
// as a compatibility fallback for terminal-minted tokens.

const LEGACY_STORAGE_KEY = 'homepage_jwt';
const PROFILE_STORAGE_KEY = 'homepage_profile';
const AUTH_BASE = 'https://auth.romaine.life';

const PROFILES = {
  personal: {
    id: 'personal',
    label: 'Personal',
    treeSub: 'nelson',
    description: 'Load personal bookmarks',
  },
  'engineered-arts': {
    id: 'engineered-arts',
    label: 'Engineered Arts',
    treeSub: 'nelson-ea',
    description: 'Load Engineered Arts bookmarks',
  },
};

const PROFILE_ALIASES = {
  personal: 'personal',
  nelson: 'personal',
  ea: 'engineered-arts',
  engineered: 'engineered-arts',
  'engineered-arts': 'engineered-arts',
  engineeredarts: 'engineered-arts',
  'nelson-ea': 'engineered-arts',
};

let cachedAuthToken = null;

// Baked-deploy mode — SWA bypass hostname (work-computer access where
// *.romaine.life is blocked). Auth and API are inert; bookmarks are served
// from a static JSON file shipped alongside the frontend. checkAuth and
// fetchWhoami fake a nelson-r1 session so the authenticated UI renders
// normally. Edit/save buttons stay wired but silently fail on API calls —
// that's intentional per the deploy's read-only framing.
const IS_BAKED = typeof window !== 'undefined' &&
  window.location.hostname.endsWith('.azurestaticapps.net');

// Absorb `#token=<jwt>` and `?profile=<id>` on module load (runs once per
// page load). The profile param is used as the post-auth callback marker.
(function absorbLoginState() {
  try {
    const url = new URL(window.location.href);
    let dirty = false;

    const tokenMatch = window.location.hash.match(/#token=([A-Za-z0-9_\-.]+)/);
    if (tokenMatch) {
      localStorage.setItem(LEGACY_STORAGE_KEY, tokenMatch[1]);
      url.hash = '';
      dirty = true;
    }

    const profile = normalizeProfileId(url.searchParams.get('profile'));
    if (profile) {
      localStorage.setItem(PROFILE_STORAGE_KEY, profile);
      url.searchParams.delete('profile');
      dirty = true;
    }

    if (dirty) {
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }
  } catch {
    // If storage or URL parsing is unavailable, leave auth state untouched.
  }
})();

function normalizeProfileId(value) {
  if (!value) return null;
  return PROFILE_ALIASES[String(value).trim().toLowerCase()] || null;
}

export function selectedProfile() {
  let profileId = null;
  try {
    profileId = normalizeProfileId(localStorage.getItem(PROFILE_STORAGE_KEY));
  } catch {
    profileId = null;
  }
  return PROFILES[profileId || 'personal'];
}

export function profileLoginUrl(profileId) {
  const profile = normalizeProfileId(profileId) || 'personal';
  const callback = new URL(window.location.origin + window.location.pathname);
  callback.searchParams.set('profile', profile);
  return `${AUTH_BASE}/sign-in/microsoft?callbackURL=${encodeURIComponent(callback.toString())}`;
}

export function profileLoginBookmarks() {
  return Object.values(PROFILES).map(profile => ({
    name: profile.label.replace(/\s+/g, '-'),
    url: profileLoginUrl(profile.id),
    description: `${profile.description} via auth.romaine.life`,
  }));
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
    return JSON.parse(atob(t.split('.')[1]));
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
  const profile = selectedProfile();
  return {
    sub: profile.treeSub,
    name: profile.label,
    email: payload.email || payload.sub,
    authSub: payload.sub,
    profile: profile.id,
  };
}

export async function logout() {
  cachedAuthToken = null;
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore storage cleanup failures.
  }

  try {
    await fetch(`${AUTH_BASE}/api/auth/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Local logout still matters if the network is unavailable.
  }

  window.location.reload();
}
