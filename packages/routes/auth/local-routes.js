import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRY = '7d';
const BLOB_CONTAINER_NAME = 'profile-pictures';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    cb(null, ALLOWED_MIME_TYPES.includes(file.mimetype));
  },
});

/**
 * Creates routes for local (username/password) auth and profile pictures.
 */
export function createLocalRoutes({ jwtSecret, storageAccountEndpoint, container, requireAuth, requireAdmin }) {
  const router = Router();

  const blobServiceClient = new BlobServiceClient(
    storageAccountEndpoint,
    new DefaultAzureCredential(),
  );
  const blobContainerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER_NAME);

  // POST /auth/local/login
  router.post('/auth/local/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const userId = `local|${username}`;
    try {
      const { resource: account } = await container.item(`account_${userId}`, userId).read();
      if (!account) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, account.passwordHash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        {
          sub: userId,
          email: null,
          name: account.displayName,
          picture: account.profilePictureUrl || null,
          isLocal: true,
        },
        jwtSecret,
        { expiresIn: JWT_EXPIRY },
      );

      res.json({ token });
    } catch (err) {
      if (err.code === 404) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      console.error('Local login error:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // POST /api/accounts — Admin-only: create a local account
  router.post('/api/accounts', requireAuth, requireAdmin, async (req, res) => {
    const { username, password, displayName } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const isEmail = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(username);
    const isPlainUsername = /^[a-zA-Z0-9_-]{3,30}$/.test(username);
    if (!isEmail && !isPlainUsername) {
      return res.status(400).json({ error: 'Must be a valid email or 3-30 characters (letters, numbers, _ -)' });
    }

    const userId = `local|${username}`;
    const docId = `account_${userId}`;

    try {
      const { resource: existing } = await container.item(docId, userId).read();
      if (existing) {
        return res.status(409).json({ error: 'Account already exists' });
      }
    } catch (err) {
      if (err.code !== 404) {
        console.error('Account check error:', err);
        return res.status(500).json({ error: 'Failed to check account' });
      }
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const account = {
      id: docId,
      userId,
      type: 'user_account',
      username,
      passwordHash,
      displayName: displayName || username,
      profilePictureUrl: null,
      createdAt: new Date().toISOString(),
      createdBy: req.user.sub,
    };

    try {
      await container.items.create(account);
      res.status(201).json({
        username: account.username,
        displayName: account.displayName,
        createdAt: account.createdAt,
      });
    } catch (err) {
      console.error('Account creation error:', err);
      res.status(500).json({ error: 'Failed to create account' });
    }
  });

  // GET /api/accounts — Admin-only: list local accounts
  router.get('/api/accounts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { resources } = await container.items
        .query({
          query: 'SELECT c.username, c.displayName, c.profilePictureUrl, c.createdAt FROM c WHERE c.type = @type',
          parameters: [{ name: '@type', value: 'user_account' }],
        })
        .fetchAll();
      res.json({ accounts: resources });
    } catch (err) {
      console.error('List accounts error:', err);
      res.status(500).json({ error: 'Failed to list accounts' });
    }
  });

  // POST /api/profile/picture
  router.post('/api/profile/picture', requireAuth, upload.single('picture'), async (req, res) => {
    if (!req.user.isLocal) {
      return res.status(403).json({ error: 'Profile pictures are only for local accounts' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No valid image file provided (JPEG or PNG, max 2 MB)' });
    }

    const ext = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
    const blobName = `${req.user.sub.replace('|', '_')}.${ext}`;
    const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);

    try {
      await blockBlobClient.uploadData(req.file.buffer, {
        blobHTTPHeaders: { blobContentType: req.file.mimetype },
        overwrite: true,
      });

      const pictureUrl = blockBlobClient.url;

      const userId = req.user.sub;
      const docId = `account_${userId}`;
      const { resource: account } = await container.item(docId, userId).read();
      account.profilePictureUrl = pictureUrl;
      await container.item(docId, userId).replace(account);

      const token = jwt.sign(
        {
          sub: req.user.sub,
          email: req.user.email,
          name: req.user.name,
          picture: pictureUrl,
          isLocal: true,
        },
        jwtSecret,
        { expiresIn: JWT_EXPIRY },
      );

      res.json({ pictureUrl, token });
    } catch (err) {
      console.error('Profile picture upload error:', err);
      res.status(500).json({ error: 'Failed to upload profile picture' });
    }
  });

  // DELETE /api/profile/picture
  router.delete('/api/profile/picture', requireAuth, async (req, res) => {
    if (!req.user.isLocal) {
      return res.status(403).json({ error: 'Profile pictures are only for local accounts' });
    }

    const userId = req.user.sub;
    const docId = `account_${userId}`;

    try {
      const { resource: account } = await container.item(docId, userId).read();
      if (!account?.profilePictureUrl) {
        return res.json({ pictureUrl: null });
      }

      const blobUrl = new URL(account.profilePictureUrl);
      const blobName = blobUrl.pathname.split('/').pop();
      const blockBlobClient = blobContainerClient.getBlockBlobClient(blobName);
      await blockBlobClient.deleteIfExists();

      account.profilePictureUrl = null;
      await container.item(docId, userId).replace(account);

      const token = jwt.sign(
        {
          sub: req.user.sub,
          email: req.user.email,
          name: req.user.name,
          picture: null,
          isLocal: true,
        },
        jwtSecret,
        { expiresIn: JWT_EXPIRY },
      );

      res.json({ pictureUrl: null, token });
    } catch (err) {
      console.error('Profile picture delete error:', err);
      res.status(500).json({ error: 'Failed to delete profile picture' });
    }
  });

  return router;
}
