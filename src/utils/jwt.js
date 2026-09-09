'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Signs a JWT for an authenticated user.
 * Payload intentionally kept minimal: id, phone, role.
 *
 * @param {{ id: string, phone: string, role: string }} user
 * @returns {string}
 */
function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      phone: user.phone,
      role: user.role,
    },
    env.jwt.secret,
    {
      expiresIn: env.jwt.expiresIn,
      issuer: env.jwt.issuer,
    },
  );
}

/**
 * Verifies a JWT and returns its decoded payload.
 * Throws jsonwebtoken's native errors (TokenExpiredError, JsonWebTokenError)
 * on failure — callers are expected to catch and translate these.
 *
 * @param {string} token
 * @returns {{ sub: string, phone: string, role: string, iat: number, exp: number }}
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwt.secret, { issuer: env.jwt.issuer });
}

module.exports = { signAccessToken, verifyAccessToken };
