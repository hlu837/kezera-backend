'use strict';

/**
 * A known, expected application error carrying an HTTP status code.
 * Anything thrown that is NOT an AppError is treated as an unexpected
 * (500) error by the global error handler.
 */
class AppError extends Error {
  /**
   * @param {string} message - Safe to show to the client.
   * @param {number} statusCode - HTTP status code.
   * @param {object} [details] - Optional structured detail (e.g. validation errors).
   */
  constructor(message, statusCode = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.isOperational = true;
    if (details) this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
