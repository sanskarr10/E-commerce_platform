import jwt from 'jsonwebtoken';
import { HttpError } from './errors.js';

/**
 * Verifies access tokens issued by the user-service. Verification is local (public key only),
 * so there is no network call per request. Trade-off: a deactivated user keeps access until
 * their token expires (15 minutes by default).
 */
export function createAuth({ publicKey, issuer, audience }) {
  const unauthorized = (detail) => new HttpError(401, detail, { 'WWW-Authenticate': 'Bearer' });

  function authenticate(req) {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw unauthorized('Not authenticated');

    let claims;
    try {
      claims = jwt.verify(token, publicKey, {
        algorithms: ['RS256'], // pinned: blocks alg=none and HS256 key-confusion tokens
        issuer,
        audience,
        clockTolerance: 5,
      });
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    // jsonwebtoken does not require an expiry, so a signed token without one would never die.
    if (typeof claims !== 'object' || !claims.sub || typeof claims.exp !== 'number') {
      throw unauthorized('Invalid or expired token');
    }
    return claims;
  }

  return {
    requireAdmin(req, _res, next) {
      const claims = authenticate(req);
      if (claims.role !== 'admin') throw new HttpError(403, 'Admin access required');
      req.user = claims;
      next();
    },
  };
}
