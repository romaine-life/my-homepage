import { Router } from 'express';

/**
 * Creates the homepage routes as an Express router.
 * Bookmarks and settings CRUD only — auth is injected from the shared API.
 *
 * @param {{
 *   requireAuth: Function,
 *   container: import('@azure/cosmos').Container,
 * }} opts
 */
export function createHomepageRoutes({ requireAuth, container }) {
  const router = Router();

  // Health check
  router.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // GET /api/bookmarks
  router.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { resources } = await container.items.query({
        query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
        parameters: [
          { name: '@type', value: 'bookmarks' },
          { name: '@userId', value: userId },
        ],
      }).fetchAll();

      if (resources.length === 0) {
        return res.json({ bookmarks: [], updatedAt: null });
      }

      res.json({ bookmarks: resources[0].bookmarks, updatedAt: resources[0].updatedAt });
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      res.status(500).json({ error: 'Failed to fetch bookmarks', message: error.message });
    }
  });

  // PUT /api/bookmarks
  router.put('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { bookmarks, lastKnownVersion } = req.body;

      if (!Array.isArray(bookmarks)) {
        return res.status(400).json({ error: 'Request body must contain a bookmarks array' });
      }

      if (lastKnownVersion) {
        const { resources } = await container.items.query({
          query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
          parameters: [
            { name: '@type', value: 'bookmarks' },
            { name: '@userId', value: userId },
          ],
        }).fetchAll();

        if (resources.length > 0) {
          const currentDoc = resources[0];
          const currentVersion = new Date(currentDoc.updatedAt).getTime();
          const clientVersion = new Date(lastKnownVersion).getTime();

          if (currentVersion > clientVersion) {
            return res.status(409).json({
              error: 'Conflict detected',
              message: 'Bookmarks have been modified elsewhere. Please merge changes.',
              currentBookmarks: currentDoc.bookmarks,
              currentVersion: currentDoc.updatedAt,
            });
          }
        }
      }

      const bookmarksDoc = {
        id: `bookmarks_${userId}`,
        userId,
        type: 'bookmarks',
        bookmarks,
        updatedAt: new Date().toISOString(),
      };

      const { resource } = await container.items.upsert(bookmarksDoc);
      res.json({ bookmarks: resource.bookmarks, updatedAt: resource.updatedAt });
    } catch (error) {
      console.error('Error saving bookmarks:', error);
      res.status(500).json({ error: 'Failed to save bookmarks', message: error.message });
    }
  });

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
