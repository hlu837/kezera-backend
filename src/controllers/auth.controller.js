'use strict';

const authService = require('../services/auth.service');

/**
 * POST /api/v1/auth/register
 * Body validated upstream by validateBody(registerSchema).
 */
async function registerHandler(req, res, next) {
  try {
    const { user, profile, token } = await authService.register(req.body);
    return res.status(201).json({
      status: 'success',
      data: { user, profile, token },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/auth/login
 * Body validated upstream by validateBody(loginSchema).
 */
async function loginHandler(req, res, next) {
  try {
    const { user, token } = await authService.login(req.body);
    return res.status(200).json({
      status: 'success',
      data: { user, token },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { registerHandler, loginHandler };
