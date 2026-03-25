import { Router } from 'express';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { configurePassport } from './auth/passport-setup.js';
import { createAuthRoutes } from './auth/routes.js';
import { createLocalRoutes } from './auth/local-routes.js';
import { createRequireAuth } from './middleware/auth.js';
import { requireAdmin } from './middleware/requireAdmin.js';

/**
 * Creates the complete homepage sub-application as an Express router.
 *
 * Includes cookie-parser and passport middleware scoped to homepage routes,
 * OAuth flows (GitHub, Google, Microsoft, Apple), local auth, bookmarks,
 * settings, and profile picture management.
 *
 * @param {{
 *   config: {
 *     jwtSigningSecret: string,
 *     githubClientId: string,
 *     githubClientSecret: string,
 *     googleClientId: string,
 *     googleClientSecret: string,
 *     microsoftClientId: string,
 *     microsoftClientSecret: string,
 *     auth0Domain: string,
 *     auth0AppleClientId: string,
 *     auth0AppleClientSecret: string,
 *     storageAccountEndpoint: string,
 *     swaDefaultHostname?: string,
 *   },
 *   container: import('@azure/cosmos').Container,
 * }} opts
 */
export function createHomepageApp({ config, container }) {
  const router = Router();

  // Homepage-specific middleware (scoped, not global)
  router.use(cookieParser());
  router.use(passport.initialize());

  // Configure passport with OAuth secrets
  configurePassport(config);

  // Auth middleware using homepage's own JWT secret
  const requireAuth = createRequireAuth({ jwtSecret: config.jwtSigningSecret });

  // Allowed redirect URIs for OAuth callbacks
  const allowedRedirectUris = [
    'https://homepage.romaine.life',
    'http://localhost:5500',
  ];
  if (config.swaDefaultHostname) {
    allowedRedirectUris.push(`https://${config.swaDefaultHostname}`);
  }

  // Mount auth routes
  router.use('/auth', createAuthRoutes({
    jwtSecret: config.jwtSigningSecret,
    allowedRedirectUris,
  }));

  // Mount local auth + profile picture routes
  router.use(createLocalRoutes({
    jwtSecret: config.jwtSigningSecret,
    storageAccountEndpoint: config.storageAccountEndpoint,
    container,
    requireAuth,
    requireAdmin,
  }));

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
