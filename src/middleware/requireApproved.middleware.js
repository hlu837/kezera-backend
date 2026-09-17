'use strict';

const { User } = require('../models');
const AppError = require('../errors/AppError');

/**
 * Blocks access for employer/agency accounts that are not yet approved.
 * Must be used AFTER the `authenticate` middleware (which sets req.user).
 *
 * Seekers and admins are always passed through since they are auto-approved.
 */
async function requireApproved(req, res, next) {
  // Only enforce for business accounts
  if (!['employer', 'agency'].includes(req.user.role)) {
    return next();
  }

  const user = await User.findById(req.user.id)
    .select('verificationStatus verificationRejectionReason accountStatus accountStatusReason');
  if (!user) {
    return next(new AppError('User not found', 404));
  }

  // Checked before verificationStatus below: an admin suspension is a
  // deliberate override of an otherwise-approved account, and should
  // read as "your access was suspended" rather than being masked by
  // (or confused with) the unrelated onboarding-approval messages.
  if (user.accountStatus === 'suspended') {
    return next(new AppError(
      `Your account has been suspended by an administrator.${
        user.accountStatusReason ? ` Reason: ${user.accountStatusReason}` : ''
      } Contact support if you believe this is a mistake.`,
      403,
    ));
  }

  if (user.verificationStatus === 'payment_pending') {
    return next(new AppError(
      'Please complete your subscription payment before accessing this feature.',
      403,
    ));
  }

  if (user.verificationStatus === 'pending') {
    return next(new AppError(
      'Your account is pending admin verification. You will be notified once approved.',
      403,
    ));
  }

  if (user.verificationStatus === 'rejected') {
    return next(new AppError(
      `Your account verification was rejected. Reason: ${user.verificationRejectionReason || 'No reason provided'}`,
      403,
    ));
  }

  if (user.verificationStatus !== 'approved') {
    return next(new AppError(
      'Your account is not yet approved to access this feature.',
      403,
    ));
  }

  return next();
}

module.exports = { requireApproved };
