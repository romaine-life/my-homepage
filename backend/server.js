import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import { CosmosClient } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { createRequireAuth } from './middleware/auth.js';
import { fetchAppConfig } from './startup/appConfig.js';
import { configurePassport } from './auth/passport-setup.js';
import { createAuthRoutes } from './auth/routes.js';
import { createLocalRoutes } from './auth/local-routes.js';
import { requireAdmin } from './middleware/requireAdmin.js';

const app = express();
const PORT = process.env.PORT || 3000;
let serverReady = false;

// Middleware that does NOT depend on async config — safe to register now
app.use(helmet());
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(morgan('combined'));
app.use(passport.initialize());

// Gate all requests (except startup probes) until async init completes.
app.use((req, res, next) => {
  if (serverReady) return next();
  res.status(503).json({ error: 'Server is starting up, please retry shortly.' });
});

async function startServer() {
  // Step 1: Fetch all config (App Configuration + Key Vault).
  const config = await fetchAppConfig();

  // Step 2: Configure passport strategies with OAuth credentials.
  configurePassport(config);

  // Step 3: Build the JWT auth middleware.
  const requireAuth = createRequireAuth({ jwtSecret: config.jwtSigningSecret });

  // Step 4: Mount auth routes (login/callback/me).
  const allowedRedirectUris = [
    'https://homepage.romaine.life',
    'http://localhost:3000',
    'http://localhost:5500',
  ];
  if (process.env.SWA_DEFAULT_HOSTNAME) {
    allowedRedirectUris.push(`https://${process.env.SWA_DEFAULT_HOSTNAME}`);
  }

  app.use('/auth', createAuthRoutes({
    jwtSecret: config.jwtSigningSecret,
    allowedRedirectUris,
  }));

  // Step 5: Initialize Cosmos DB client.
  const DATABASE_NAME = process.env.COSMOS_DB_DATABASE_NAME || 'HomepageDB';
  const CONTAINER_NAME = process.env.COSMOS_DB_CONTAINER_NAME || 'userdata';

  let container;
  try {
    const credential = new DefaultAzureCredential();
    const client = new CosmosClient({
      endpoint: config.cosmosDbEndpoint,
      aadCredentials: credential
    });

    const database = client.database(DATABASE_NAME);
    container = database.container(CONTAINER_NAME);
    console.log('Connected to Cosmos DB using Azure Identity');
  } catch (error) {
    console.error('Failed to connect to Cosmos DB:', error);
    process.exit(1);
  }

  // Step 6: Mount local auth + profile picture routes (needs Cosmos container).
  app.use(createLocalRoutes({
    jwtSecret: config.jwtSigningSecret,
    storageAccountEndpoint: config.storageAccountEndpoint,
    container,
    requireAuth,
    requireAdmin,
  }));

  // Step 7: Register all routes.

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: DATABASE_NAME,
      container: CONTAINER_NAME
    });
  });

  // Get bookmarks for the authenticated user
  app.get('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const querySpec = {
        query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
        parameters: [
          { name: '@type', value: 'bookmarks' },
          { name: '@userId', value: userId }
        ]
      };

      const { resources } = await container.items.query(querySpec).fetchAll();

      if (resources.length === 0) {
        return res.json({ bookmarks: [] });
      }

      res.json({ bookmarks: resources[0].bookmarks });
    } catch (error) {
      console.error('Error fetching bookmarks:', error);
      res.status(500).json({ error: 'Failed to fetch bookmarks', message: error.message });
    }
  });

  // Save/update bookmarks for the authenticated user
  app.put('/api/bookmarks', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;
      const { bookmarks } = req.body;

      if (!Array.isArray(bookmarks)) {
        return res.status(400).json({ error: 'Request body must contain a bookmarks array' });
      }

      const bookmarksDoc = {
        id: `bookmarks_${userId}`,
        userId,
        type: 'bookmarks',
        bookmarks,
        updatedAt: new Date().toISOString()
      };

      const { resource } = await container.items.upsert(bookmarksDoc);

      res.json({ bookmarks: resource.bookmarks, updatedAt: resource.updatedAt });
    } catch (error) {
      console.error('Error saving bookmarks:', error);
      res.status(500).json({ error: 'Failed to save bookmarks', message: error.message });
    }
  });

  // Get settings for the authenticated user
  app.get('/api/settings', requireAuth, async (req, res) => {
    try {
      const userId = req.user.sub;

      const querySpec = {
        query: 'SELECT * FROM c WHERE c.type = @type AND c.userId = @userId',
        parameters: [
          { name: '@type', value: 'settings' },
          { name: '@userId', value: userId }
        ]
      };

      const { resources } = await container.items.query(querySpec).fetchAll();

      if (resources.length === 0) {
        return res.json({ settings: {} });
      }

      res.json({ settings: resources[0].settings });
    } catch (error) {
      console.error('Error fetching settings:', error);
      res.status(500).json({ error: 'Failed to fetch settings', message: error.message });
    }
  });

  // Save/update settings for the authenticated user
  app.put('/api/settings', requireAuth, async (req, res) => {
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
        updatedAt: new Date().toISOString()
      };

      const { resource } = await container.items.upsert(settingsDoc);

      res.json({ settings: resource.settings, updatedAt: resource.updatedAt });
    } catch (error) {
      console.error('Error saving settings:', error);
      res.status(500).json({ error: 'Failed to save settings', message: error.message });
    }
  });

  // In production, serve frontend static files
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('../frontend'));
  }

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  });

  console.log(`Database: ${DATABASE_NAME}`);
  console.log(`Container: ${CONTAINER_NAME}`);
  serverReady = true;
  console.log('Server ready');
}

// Listen immediately so Azure startup probes pass while async init runs.
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}, initializing...`);
});

startServer().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

export default app;
