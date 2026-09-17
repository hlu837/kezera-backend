'use strict';

const AppError = require('../errors/AppError');

/**
 * Returns an Express middleware that validates `req.body` against the
 * given Joi schema. On failure, responds with 422 and a field-level
 * breakdown; on success, replaces req.body with the sanitized value.
 *
 * @param {import('joi').ObjectSchema} schema
 */
function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body);
    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return next(new AppError('Validation failed', 422, details));
    }
    req.body = value;
    return next();
  };
}

/**
 * Returns an Express middleware that validates `req.query` against the
 * given Joi schema. On failure, responds with 422 and a field-level
 * breakdown; on success, replaces req.query with the sanitized value
 * (e.g. comma-separated strings converted to arrays, trimmed strings).
 *
 * @param {import('joi').ObjectSchema} schema
 */
function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query);
    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return next(new AppError('Invalid query parameters', 422, details));
    }
    req.query = value;
    return next();
  };
}

/**
 * Returns an Express middleware that validates `req.params` against the
 * given Joi schema (e.g. UUID route params like `:id`). On failure,
 * responds with 422; on success, replaces req.params with the sanitized
 * value.
 *
 * @param {import('joi').ObjectSchema} schema
 */
function validateParams(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.params);
    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return next(new AppError('Invalid route parameters', 422, details));
    }
    req.params = value;
    return next();
  };
}

module.exports = { validateBody, validateQuery, validateParams };
