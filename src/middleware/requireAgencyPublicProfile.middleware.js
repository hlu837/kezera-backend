'use strict';

const agencyService = require('../services/agency.service');
const AppError = require('../errors/AppError');

/**
 * Blocks POST /api/v1/jobs/create for an agency that hasn't built out a
 * public profile yet (no bio, no logo — see Agency.model.js's `bio`/
 * `logoUrl`). An employer request passes straight through; this is an
 * agency-only requirement.
 *
 * Grandfathering: an agency that already has at least one job posted is
 * always let through, even with an empty bio/logo — see
 * agency.service.js#canPostJob. In practice this means the rule only
 * ever blocks an agency posting its very first job after this shipped;
 * every agency that was already active keeps working exactly as before.
 *
 * Must run AFTER `authenticate` (needs `req.user`) and is only meaningful
 * on job-creation routes — mount it directly on POST /jobs/create, not
 * on the router's blanket `employer`/`agency` guard, so employer requests
 * never pay for the extra Agency/Job lookups this does.
 */
async function requireAgencyPublicProfile(req, res, next) {
  if (req.user.role !== 'agency') {
    return next();
  }

  try {
    const allowed = await agencyService.canPostJob(req.user.id);
    if (!allowed) {
      return next(new AppError(
        'Add a bio or logo to your public agency profile before posting a job. '
          + 'You can do this from Account > Edit profile.',
        403,
      ));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAgencyPublicProfile };
