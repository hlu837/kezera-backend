'use strict';

const AppError = require('../errors/AppError');

/**
 * Catch-all for unmatched routes. Must be registered after all routes.
 */
function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

/**
 * Central error handler. Must be registered LAST (4-arg signature is
 * what tells Express this is an error middleware).
 *
 * - Known AppErrors are returned with their intended status/message.
 * - MongoDB duplicate-key errors (E11000) are translated to 409 as a
 *   safety net; services/auth.service.js already handles its own
 *   register() duplicate case with a more specific message, but this
 *   catches any other Mongo write that isn't wrapped that way.
 * - Mongoose validation errors (e.g. User's phone-or-email pre-validate
 *   hook, or a schema `required`/`enum` failure) are translated to 422.
 * - Everything else is logged and returned as an opaque 500.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Defensive fallback: upload.middleware.js normally translates Multer's
  // errors into AppError before they reach here, but this guards any
  // route that invokes multer directly in the future.
  if (err && err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ status: 'error', message: err.message });
  }

  if (err && err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'value';
    return res.status(409).json({
      status: 'error',
      message: `A record with this ${field} already exists`,
    });
  }

  if (err && err.name === 'ValidationError' && err.errors) {
    // Mongoose's own ValidationError shape (distinct from Joi's, which
    // is already translated into an AppError by validate.middleware.js
    // before a request ever reaches a service).
    const details = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));
    return res.status(422).json({ status: 'error', message: 'Validation failed', details });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // eslint-disable-next-line no-console
  console.error('[unhandled error]', err);
  return res.status(500).json({
    status: 'error',
    message: 'An unexpected error occurred. Please try again later.',
  });
}

module.exports = { notFoundHandler, errorHandler };
