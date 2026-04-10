import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';

/**
 * Creates the homepage routes as an Express router.
 *
 * @param {{
 *   requireAuth: Function,
 *   container: import('@azure/cosmos').Container,
 *   bookmarksContainerClient: import('@azure/storage-blob').ContainerClient,
 *   jwtSecret: string,
 *   frontendUrl: string,
 * }} opts
 */
export function createHomepageRoutes({ requireAuth, container, bookmarksContainerClient, jwtSecret, frontendUrl }) {
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

  // ── Bookmarks (Blob Storage) ────────────────────────────────────

  // Sanitize userId for use as a blob name
  function blobName(userId) {
    return userId.replace(/[|]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '') + '.yaml';
  }

  // Read a JSON blob by name. Returns { data, lastModified } or null.
  async function readBlob(name) {
    const blob = bookmarksContainerClient.getBlobClient(name);
    const props = await blob.getProperties().catch(() => null);
    if (!props) return null;
    const download = await blob.download(0);
    const chunks = [];
    for await (const chunk of download.readableStreamBody) {
      chunks.push(chunk);
    }
    return {
      data: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
      lastModified: props.lastModified,
    };
  }

  // Write a JSON blob by name. Returns { lastModified }.
  async function writeBlob(name, data) {
    const blob = bookmarksContainerClient.getBlockBlobClient(name);
    const content = JSON.stringify(data);
    await blob.upload(content, content.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
    const props = await blob.getProperties();
    return { lastModified: props.lastModified };
  }

  // Resolve ref nodes in a bookmark tree. Each { ref: "name" } node is replaced
  // with the contents of the referenced blob, tagged with _ref and _refVersion
  // metadata so the PUT handler can decompose edits back to source blobs.
  async function resolveRefs(bookmarks, visited = new Set()) {
    const resolved = [];
    for (const item of bookmarks) {
      if (item.ref && Object.keys(item).filter(k => k !== '_refError').length === 1) {
        if (visited.has(item.ref) || visited.size >= 10) {
          resolved.push({ ...item, _refError: true });
          continue;
        }
        const result = await readBlob(item.ref + '.yaml');
        if (!result) {
          resolved.push({ ...item, _refError: true });
          continue;
        }
        const node = { ...result.data, _ref: item.ref, _refVersion: result.lastModified.toISOString() };
        // Recursively resolve refs within the referenced tree
        if (Array.isArray(node.children) && node.children.length > 0) {
          const childVisited = new Set(visited);
          childVisited.add(item.ref);
          node.children = await resolveRefs(node.children, childVisited);
        }
        resolved.push(node);
      } else {
        // Regular node — recursively resolve children
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

  // GET /api/bookmarks — read bookmark JSON from blob storage, resolve refs
  router.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const result = await readBlob(blobName(req.user.sub));
      if (!result) {
        return res.json({ bookmarks: [], updatedAt: null });
      }

      const bookmarks = await resolveRefs(result.data);
      res.json({ bookmarks, updatedAt: result.lastModified.toISOString() });
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      res.status(500).json({ error: 'Failed to fetch bookmarks', message: error.message });
    }
  });

  // PUT /api/bookmarks — decompose refs, write ref blobs, save user tree
  router.put('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const { bookmarks, lastKnownVersion } = req.body;

      if (!Array.isArray(bookmarks)) {
        return res.status(400).json({ error: 'Request body must contain a bookmarks array' });
      }

      const userBlobName = blobName(req.user.sub);

      // Conflict detection on the user's own blob
      if (lastKnownVersion) {
        const current = await readBlob(userBlobName);
        if (current) {
          const currentVersion = current.lastModified.getTime();
          const clientVersion = new Date(lastKnownVersion).getTime();
          if (currentVersion > clientVersion) {
            const currentBookmarks = await resolveRefs(current.data);
            return res.status(409).json({
              error: 'Conflict detected',
              message: 'Bookmarks have been modified elsewhere. Please merge changes.',
              currentBookmarks,
              currentVersion: current.lastModified.toISOString(),
            });
          }
        }
      }

      // Decompose resolved refs back into pointers + ref blob writes
      const { userTree, refWrites } = decomposeRefs(bookmarks);

      // Check ref blob versions and write changed refs
      for (const rw of refWrites) {
        if (rw.expectedVersion) {
          const current = await readBlob(rw.ref + '.yaml');
          if (current) {
            const currentVersion = current.lastModified.getTime();
            const clientVersion = new Date(rw.expectedVersion).getTime();
            if (currentVersion > clientVersion) {
              return res.status(409).json({
                error: 'Ref conflict',
                message: `Shared bookmark "${rw.ref}" was modified elsewhere.`,
                ref: rw.ref,
              });
            }
          }
        }
        await writeBlob(rw.ref + '.yaml', rw.data);
      }

      // Save the user's tree (contains { ref } pointers, not expanded data)
      const { lastModified } = await writeBlob(userBlobName, userTree);

      // Re-resolve and return the full tree so the frontend has fresh _refVersions
      const resolved = await resolveRefs(userTree);
      res.json({ bookmarks: resolved, updatedAt: lastModified.toISOString() });
    } catch (error) {
      console.error('Error saving bookmarks:', error);
      res.status(500).json({ error: 'Failed to save bookmarks', message: error.message });
    }
  });

  // ── Menu (Blob Storage) ─────────────────────────────────────────
  // Full menu tree per identity. Used by fzt-automate and any future consumer.
  // Blob naming: menu-{userId}.yaml (separate from bookmarks).

  function menuBlobName(userId) {
    return 'menu-' + userId.replace(/[|]/g, '_').replace(/[^a-zA-Z0-9_-]/g, '') + '.yaml';
  }

  // GET /api/menu — fetch the full menu tree for the authenticated user
  router.get('/api/menu', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const result = await readBlob(menuBlobName(userId));
      if (!result) {
        return res.json({ menu: [], updatedAt: null });
      }
      res.json({ menu: result.data, updatedAt: result.lastModified.toISOString() });
    } catch (error) {
      console.error('Error fetching menu:', error);
      res.status(500).json({ error: 'Failed to fetch menu', message: error.message });
    }
  });

  // PUT /api/menu — save the full menu tree
  router.put('/api/menu', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { menu, lastKnownVersion } = req.body;

      if (!Array.isArray(menu)) {
        return res.status(400).json({ error: 'Request body must contain a menu array' });
      }

      // Conflict detection
      if (lastKnownVersion) {
        const current = await readBlob(menuBlobName(userId));
        if (current && current.lastModified > new Date(lastKnownVersion)) {
          return res.status(409).json({
            error: 'Conflict detected',
            message: 'Menu has been modified elsewhere.',
            currentMenu: current.data,
            currentVersion: current.lastModified.toISOString(),
          });
        }
      }

      const { lastModified } = await writeBlob(menuBlobName(userId), menu);
      res.json({ menu, updatedAt: lastModified.toISOString() });
    } catch (error) {
      console.error('Error saving menu:', error);
      res.status(500).json({ error: 'Failed to save menu', message: error.message });
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
