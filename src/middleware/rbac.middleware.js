'use strict';

const AppError = require('../errors/AppError');

/**
 * Restricts a route to one or more roles. Must run AFTER `authenticate`,
 * since it relies on `req.user.role` being populated from the JWT.
 *
 * Usage:
 *   router.get('/admin/stats', authenticate, authorizeRoles('admin'), handler);
 *   router.post('/jobs', authenticate, authorizeRoles('employer', 'agency'), handler);
 *
 * `admin` is formalized as agency's superset: any route open to `agency`
 * is implicitly open to `admin` too, so a route that lists `'agency'`
 * doesn't also need to spell out `'admin'` — and can't accidentally
 * forget to. This is a one-way elevation (agency access implies admin
 * access) rather than a general role hierarchy: routes gated to
 * `employer` or `seeker` alone are NOT opened to `admin` by this rule,
 * since there's no equivalent "admin acts as employer/seeker" product
 * decision behind those roles.
 *
 * @param  {...('seeker'|'employer'|'agency'|'admin')} allowedRoles
 */
function authorizeRoles(...allowedRoles) {
  if (allowedRoles.length === 0) {
    throw new Error('authorizeRoles() requires at least one role');
  }

  const effectiveRoles = allowedRoles.includes('agency')
    ? [...allowedRoles, 'admin']
    : allowedRoles;

  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return next(new AppError('Authentication required', 401));
    }

    if (!effectiveRoles.includes(req.user.role)) {
      return next(
        new AppError(
          `Access denied: requires one of [${effectiveRoles.join(', ')}]`,
          403,
        ),
      );
    }

    return next();
  };
}

module.exports = { authorizeRoles };
