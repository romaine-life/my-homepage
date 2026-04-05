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

  // GET /api/bookmarks — read bookmark YAML from blob storage
  router.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const blob = bookmarksContainerClient.getBlobClient(blobName(req.user.sub));
      const props = await blob.getProperties().catch(() => null);
      if (!props) {
        return res.json({ bookmarks: [], updatedAt: null });
      }

      const download = await blob.download(0);
      const chunks = [];
      for await (const chunk of download.readableStreamBody) {
        chunks.push(chunk);
      }
      const yaml = Buffer.concat(chunks).toString('utf-8');

      // The blob stores a JSON-serialized bookmarks array
      const bookmarks = JSON.parse(yaml);
      res.json({ bookmarks, updatedAt: props.lastModified.toISOString() });
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      res.status(500).json({ error: 'Failed to fetch bookmarks', message: error.message });
    }
  });

  // PUT /api/bookmarks — write bookmark JSON to blob storage (versioned automatically)
  router.put('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const { bookmarks, lastKnownVersion } = req.body;

      if (!Array.isArray(bookmarks)) {
        return res.status(400).json({ error: 'Request body must contain a bookmarks array' });
      }

      const blob = bookmarksContainerClient.getBlockBlobClient(blobName(req.user.sub));

      // Conflict detection via blob last-modified
      if (lastKnownVersion) {
        const props = await blob.getProperties().catch(() => null);
        if (props) {
          const currentVersion = props.lastModified.getTime();
          const clientVersion = new Date(lastKnownVersion).getTime();
          if (currentVersion > clientVersion) {
            const download = await blob.download(0);
            const chunks = [];
            for await (const chunk of download.readableStreamBody) {
              chunks.push(chunk);
            }
            const currentBookmarks = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            return res.status(409).json({
              error: 'Conflict detected',
              message: 'Bookmarks have been modified elsewhere. Please merge changes.',
              currentBookmarks,
              currentVersion: props.lastModified.toISOString(),
            });
          }
        }
      }

      const content = JSON.stringify(bookmarks);
      await blob.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: 'application/json' },
      });

      const props = await blob.getProperties();
      res.json({ bookmarks, updatedAt: props.lastModified.toISOString() });
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
