import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

/** Verifies access tokens locally with the user-service PUBLIC key (RS256 pinned). */
export function createAuth({ publicKey, issuer, audience }) {
  const unauthorized = (detail) => new HttpError(401, detail, { 'WWW-Authenticate': 'Bearer' });
  return {
    requireUser(req, _res, next) {
      const [scheme, token] = (req.get('authorization') ?? '').split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized('Not authenticated');
      let claims;
      try {
        claims = jwt.verify(token, publicKey, { algorithms: ['RS256'], issuer, audience, clockTolerance: 5 });
      } catch {
        throw unauthorized('Invalid or expired token');
      }
      if (typeof claims !== 'object' || !claims.sub || typeof claims.exp !== 'number') {
        throw unauthorized('Invalid or expired token');
      }
      req.user = { id: String(claims.sub), role: claims.role };
      next();
    },
  };
}
