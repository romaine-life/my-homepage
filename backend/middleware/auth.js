import jwt from 'jsonwebtoken';

/**
 * Creates Express middleware that verifies our self-signed JWTs.
 *
 * Populates `req.user` with `{ sub, email, name, picture }`.
 *
 * @param {{ jwtSecret: string }} config
 * @returns {import('express').RequestHandler}
 */
export function createRequireAuth({ jwtSecret }) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }

    try {
      const payload = jwt.verify(authHeader.slice(7), jwtSecret);
      req.user = {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        isLocal: payload.isLocal || false,
      };
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}
