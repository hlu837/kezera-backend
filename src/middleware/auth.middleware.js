'use strict';

const { verifyAccessToken } = require('../utils/jwt');
const AppError = require('../errors/AppError');
const User = require('../models/User.model');

// How stale `lastActiveAt` has to be before we bother writing a fresh
// one. Every authenticated request goes through here, so without a
// threshold "last seen" would mean a DB write on every single API
// call; a caller polling their inbox every few seconds doesn't need
// second-level precision here, and the query below (`$or` against
// `null`/stale) keeps this to zero *extra reads* either way.
const LAST_ACTIVE_STALE_MS = 5 * 60 * 1000;

/**
 * Fire-and-forget "last seen" touch. Never awaited by the caller and
 * never allowed to fail the request — this is a nice-to-have signal
 * for employer/agency candidate views, not something a login or job
 * apply should ever break over. The staleness filter is applied in
 * the query itself so this stays a single conditional write, not a
 * read-then-write.
 */
function touchLastActive(userId) {
  const staleBefore = new Date(Date.now() - LAST_ACTIVE_STALE_MS);
  User.updateOne(
    { _id: userId, $or: [{ lastActiveAt: null }, { lastActiveAt: { $lt: staleBefore } }] },
    { $set: { lastActiveAt: new Date() } },
  ).catch(() => {
    // Best-effort only — a failed presence update is never worth
    // logging noise or, worse, taking down an otherwise-good request.
  });
}

/**
 * Verifies the `Authorization: Bearer <token>` header on protected routes.
 * On success, attaches the decoded payload to `req.user`:
 *   { sub: userId, phone, role, iat, exp }
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError('Missing or malformed Authorization header', 401));
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      phone: payload.phone,
      role: payload.role,
    };
    touchLastActive(payload.sub);
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(new AppError('Access token has expired', 401));
    }
    return next(new AppError('Invalid access token', 401));
  }
}

module.exports = { authenticate };
