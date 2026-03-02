import { Router } from 'express';
import passport from 'passport';
import jwt from 'jsonwebtoken';

const COOKIE_NAME = 'auth_redirect_uri';
const COOKIE_MAX_AGE = 10 * 60 * 1000; // 10 minutes
const JWT_EXPIRY = '7d';

/**
 * Creates the /auth router.
 *
 * @param {{ jwtSecret: string, allowedRedirectUris: string[] }} opts
 */
export function createAuthRoutes({ jwtSecret, allowedRedirectUris }) {
  const router = Router();

  // ── Helper: build the dynamic callback URL from the current request ───
  function callbackURL(req, provider) {
    const proto = req.get('x-forwarded-proto') || req.protocol;
    return `${proto}://${req.get('host')}/auth/${provider}/callback`;
  }

  // ── Helper: validate + store redirect_uri in a short-lived cookie ─────
  function storeRedirectUri(req, res) {
    const uri = req.query.redirect_uri || '';
    const allowed = allowedRedirectUris.some((allowed) =>
      uri === allowed || uri.startsWith(allowed + '/'),
    );
    const target = allowed ? uri : allowedRedirectUris[0];
    res.cookie(COOKIE_NAME, target, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE,
    });
    return target;
  }

  // ── Helper: finish the OAuth flow by signing a JWT and redirecting ────
  function finishAuth(req, res) {
    const user = req.user;
    const redirectUri = req.cookies?.[COOKIE_NAME] || allowedRedirectUris[0];
    res.clearCookie(COOKIE_NAME);

    const token = jwt.sign(
      { sub: user.id, email: user.email, name: user.name, picture: user.picture },
      jwtSecret,
      { expiresIn: JWT_EXPIRY },
    );

    // Redirect to frontend with token in URL fragment (never sent to server)
    res.redirect(`${redirectUri}/#token=${token}`);
  }

  // ── Provider routes ───────────────────────────────────────────────────

  // GitHub
  router.get('/github', (req, res, next) => {
    storeRedirectUri(req, res);
    passport.authenticate('github', {
      callbackURL: callbackURL(req, 'github'),
      scope: ['user:email'],
    })(req, res, next);
  });

  router.get('/github/callback', (req, res, next) => {
    passport.authenticate('github', {
      callbackURL: callbackURL(req, 'github'),
      failureRedirect: '/',
      session: false,
    })(req, res, next);
  }, finishAuth);

  // Google
  router.get('/google', (req, res, next) => {
    storeRedirectUri(req, res);
    passport.authenticate('google', {
      callbackURL: callbackURL(req, 'google'),
      scope: ['openid', 'email', 'profile'],
    })(req, res, next);
  });

  router.get('/google/callback', (req, res, next) => {
    passport.authenticate('google', {
      callbackURL: callbackURL(req, 'google'),
      failureRedirect: '/',
      session: false,
    })(req, res, next);
  }, finishAuth);

  // Microsoft
  router.get('/microsoft', (req, res, next) => {
    storeRedirectUri(req, res);
    passport.authenticate('microsoft', {
      callbackURL: callbackURL(req, 'microsoft'),
      scope: ['openid', 'profile', 'email'],
    })(req, res, next);
  });

  router.get('/microsoft/callback', (req, res, next) => {
    passport.authenticate('microsoft', {
      callbackURL: callbackURL(req, 'microsoft'),
      failureRedirect: '/',
      session: false,
    })(req, res, next);
  }, finishAuth);

  // Apple (via Auth0)
  router.get('/apple', (req, res, next) => {
    storeRedirectUri(req, res);
    passport.authenticate('apple', {
      callbackURL: callbackURL(req, 'apple'),
      connection: 'apple',
    })(req, res, next);
  });

  router.get('/apple/callback', (req, res, next) => {
    passport.authenticate('apple', {
      callbackURL: callbackURL(req, 'apple'),
      failureRedirect: '/',
      session: false,
    })(req, res, next);
  }, finishAuth);

  // ── GET /auth/me — return user info from JWT ─────────────────────────
  router.get('/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      const payload = jwt.verify(authHeader.slice(7), jwtSecret);
      res.json({ sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture });
    } catch {
      res.status(401).json({ error: 'Invalid token' });
    }
  });

  return router;
}
