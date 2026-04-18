import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Creates the homepage routes as an Express router.
 *
 * @param {{
 *   requireAuth: Function,
 *   container: import('@azure/cosmos').Container,  // HomepageDB.userdata (settings)
 *   bookmarksContainer: import('@azure/cosmos').Container,  // HomepageDB.fzt-frontend-data (bookmarks + shared refs)
 *   jwtSecret: string,
 *   frontendUrl: string,
 * }} opts
 */
export function createHomepageRoutes({ requireAuth, container, bookmarksContainer, jwtSecret, frontendUrl }) {
  const router = Router();

  // ── One-time code store (in-memory, short-lived) ────────────────
  const pendingCodes = new Map();
  const CODE_TTL_MS = 30_000; // 30 seconds

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── Auth: terminal → browser cookie flow ────────────────────────

  // POST /auth/code — terminal sends JWT, receives a one-time code
  router.post('/auth/code', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });

    try {
      jwt.verify(token, jwtSecret);
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }

    const code = randomBytes(32).toString('hex');
    pendingCodes.set(code, { token, expires: Date.now() + CODE_TTL_MS });

    // Clean up expired codes
    for (const [k, v] of pendingCodes) {
      if (v.expires < Date.now()) pendingCodes.delete(k);
    }

    res.json({ code });
  });

  // GET /auth/callback?code=... — browser opens this, gets a cookie, redirects
  router.get('/auth/callback', (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const entry = pendingCodes.get(code);
    if (!entry || entry.expires < Date.now()) {
      pendingCodes.delete(code);
      return res.status(401).send('Invalid or expired code');
    }

    pendingCodes.delete(code);

    res.cookie('auth_token', entry.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    res.redirect(frontendUrl || '/');
  });

  // GET /auth/whoami — return identity from JWT cookie
  router.get('/auth/whoami', (req, res) => {
    const cookies = req.headers.cookie || '';
    const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('auth_token='));
    if (!match) return res.status(401).json({ error: 'not authenticated' });

    try {
      const decoded = jwt.verify(match.slice('auth_token='.length), jwtSecret);
      res.json({ name: decoded.name || null, email: decoded.email || decoded.sub });
    } catch {
      res.status(401).json({ error: 'invalid token' });
    }
  });

  // GET /auth/logout — clear cookie and redirect
  router.get('/auth/logout', (req, res) => {
    res.clearCookie('auth_token', { path: '/' });
    res.redirect(frontendUrl || '/');
  });

  // ── Bookmarks (Cosmos DB, fzt-frontend-data container) ──────────
  //
  // Storage model: append-only versioned docs. Each save creates a new
  // version doc; GET returns the latest version per user. Shared refs
  // (bookmarks-shared docs) are partitioned by "shared:<name>" and named
  // after the ref they satisfy.

  function bookmarksDocId(userId, version) {
    return `bookmarks_${userId}_v${version}`;
  }
  function sharedDocId(name, version) {
    return `bookmarks-shared_${name}_v${version}`;
  }

  async function getLatestBookmarks(userId) {
    const { resources } = await bookmarksContainer.items.query({
      query: `SELECT TOP 1 * FROM c
              WHERE c.type = 'bookmarks' AND c.userId = @userId
              ORDER BY c.version DESC`,
      parameters: [{ name: '@userId', value: userId }],
    }).fetchAll();
    return resources[0] || null;
  }

  async function getLatestShared(name) {
    const partition = `shared:${name}`;
    const { resources } = await bookmarksContainer.items.query({
      query: `SELECT TOP 1 * FROM c
              WHERE c.type = 'bookmarks-shared' AND c.name = @name
              ORDER BY c.version DESC`,
      parameters: [{ name: '@name', value: name }],
    }, { partitionKey: partition }).fetchAll();
    return resources[0] || null;
  }

  async function writeBookmarks(userId, bookmarks) {
    const latest = await getLatestBookmarks(userId);
    const nextVersion = (latest?.version || 0) + 1;
    const now = new Date().toISOString();
    const doc = {
      id: bookmarksDocId(userId, nextVersion),
      userId, type: 'bookmarks', version: nextVersion, bookmarks, updatedAt: now,
    };
    await bookmarksContainer.items.create(doc);
    return doc;
  }

  async function writeShared(name, bookmarks) {
    const latest = await getLatestShared(name);
    const nextVersion = (latest?.version || 0) + 1;
    const now = new Date().toISOString();
    const doc = {
      id: sharedDocId(name, nextVersion),
      userId: `shared:${name}`, type: 'bookmarks-shared', name,
      version: nextVersion, bookmarks, updatedAt: now,
    };
    await bookmarksContainer.items.create(doc);
    return doc;
  }

  // Resolve ref nodes in a bookmark tree. Each { ref: "name" } node is
  // replaced with the contents of the bookmarks-shared doc of that name,
  // tagged with _ref and _refVersion so PUT can decompose edits back.
  async function resolveRefs(bookmarks, visited = new Set()) {
    const resolved = [];
    for (const item of bookmarks) {
      if (item.ref && Object.keys(item).filter(k => k !== '_refError').length === 1) {
        if (visited.has(item.ref) || visited.size >= 10) {
          resolved.push({ ...item, _refError: true });
          continue;
        }
        const sharedDoc = await getLatestShared(item.ref);
        if (!sharedDoc) {
          resolved.push({ ...item, _refError: true });
          continue;
        }
        const node = { ...sharedDoc.bookmarks, _ref: item.ref, _refVersion: sharedDoc.version };
        if (Array.isArray(node.children) && node.children.length > 0) {
          const childVisited = new Set(visited);
          childVisited.add(item.ref);
          node.children = await resolveRefs(node.children, childVisited);
        }
        resolved.push(node);
      } else {
        if (Array.isArray(item.children) && item.children.length > 0) {
          item.children = await resolveRefs(item.children, visited);
        }
        resolved.push(item);
      }
    }
    return resolved;
  }

  // Decompose a resolved bookmark tree back into user-owned nodes and ref writes.
  // Nodes with _ref metadata are extracted: the subtree (without _ref/_refVersion)
  // becomes a ref blob write, and the node is replaced with { ref: "name" }.
  function decomposeRefs(bookmarks) {
    const refWrites = [];

    function walk(items) {
      return items.map(item => {
        if (item._ref) {
          const ref = item._ref;
          const expectedVersion = item._refVersion;
          // Strip metadata, extract the subtree for writing to the ref blob
          const { _ref, _refVersion, ...data } = item;
          // Recursively decompose nested refs within this subtree
          if (Array.isArray(data.children) && data.children.length > 0) {
            data.children = walk(data.children);
          }
          refWrites.push({ ref, data, expectedVersion });
          return { ref };
        }
        // Regular node — recurse into children
        if (Array.isArray(item.children) && item.children.length > 0) {
          return { ...item, children: walk(item.children) };
        }
        return item;
      });
    }

    const userTree = walk(bookmarks);
    return { userTree, refWrites };
  }

  // GET /api/bookmarks — read latest bookmarks doc from Cosmos, resolve refs
  router.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const latest = await getLatestBookmarks(req.user.sub);
      if (!latest) {
        return res.json({ bookmarks: [], updatedAt: null });
      }

      const bookmarks = await resolveRefs(latest.bookmarks);
      res.json({ bookmarks, updatedAt: latest.updatedAt });
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      res.status(500).json({ error: 'Failed to fetch bookmarks', message: error.message });
    }
  });

  // PUT /api/bookmarks — decompose refs, write shared-ref docs, save user tree
  router.put('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const { bookmarks, lastKnownVersion } = req.body;

      if (!Array.isArray(bookmarks)) {
        return res.status(400).json({ error: 'Request body must contain a bookmarks array' });
      }

      const userId = req.user.sub;

      // Conflict detection on the user's own bookmarks doc (by version)
      if (lastKnownVersion !== undefined && lastKnownVersion !== null) {
        const current = await getLatestBookmarks(userId);
        if (current && current.updatedAt !== lastKnownVersion && current.version !== lastKnownVersion) {
          const currentBookmarks = await resolveRefs(current.bookmarks);
          return res.status(409).json({
            error: 'Conflict detected',
            message: 'Bookmarks have been modified elsewhere. Please merge changes.',
            currentBookmarks,
            currentVersion: current.updatedAt,
          });
        }
      }

      // Decompose resolved refs back into pointers + shared-ref writes
      const { userTree, refWrites } = decomposeRefs(bookmarks);

      // Check shared-ref versions and write changed refs
      for (const rw of refWrites) {
        if (rw.expectedVersion !== undefined && rw.expectedVersion !== null) {
          const current = await getLatestShared(rw.ref);
          if (current && current.version !== rw.expectedVersion) {
            return res.status(409).json({
              error: 'Ref conflict',
              message: `Shared bookmark "${rw.ref}" was modified elsewhere.`,
              ref: rw.ref,
            });
          }
        }
        await writeShared(rw.ref, rw.data);
      }

      // Save the user's tree (contains { ref } pointers, not expanded data)
      const savedDoc = await writeBookmarks(userId, userTree);

      // Re-resolve and return the full tree so the frontend has fresh _refVersions
      const resolved = await resolveRefs(savedDoc.bookmarks);
      res.json({ bookmarks: resolved, updatedAt: savedDoc.updatedAt });
    } catch (error) {
      console.error('Error saving bookmarks:', error);
      res.status(500).json({ error: 'Failed to save bookmarks', message: error.message });
    }
  });

  // ── Settings (Cosmos DB) ────────────────────────────────────────

  // GET /api/settings
  router.get('/api/settings', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { resources } = await container.items.query({
        query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
        parameters: [
          { name: '@type', value: 'settings' },
          { name: '@userId', value: userId },
        ],
      }).fetchAll();

      if (resources.length === 0) {
        return res.json({ settings: {} });
      }

      res.json({ settings: resources[0].settings });
    } catch (error) {
      console.error('Error fetching settings:', error);
      res.status(500).json({ error: 'Failed to fetch settings', message: error.message });
    }
  });

  // PUT /api/settings
  router.put('/api/settings', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { settings } = req.body;

      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return res.status(400).json({ error: 'Request body must contain a settings object' });
      }

      const settingsDoc = {
        id: `settings_${userId}`,
        userId,
        type: 'settings',
        settings,
        updatedAt: new Date().toISOString(),
      };

      const { resource } = await container.items.upsert(settingsDoc);
      res.json({ settings: resource.settings, updatedAt: resource.updatedAt });
    } catch (error) {
      console.error('Error saving settings:', error);
      res.status(500).json({ error: 'Failed to save settings', message: error.message });
    }
  });

  return router;
}
