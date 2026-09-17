'use strict';

const bcrypt = require('bcrypt');
const { mongoose } = require('../config/mongoose');
const { User, Seeker, Employer, Agency } = require('../models');
const { signAccessToken } = require('../utils/jwt');
const env = require('../config/env');
const AppError = require('../errors/AppError');

const DEMO_APPROVED_EMAILS = new Set([
  'employer.demo@example.com',
  'agency.demo@example.com',
]);

function shouldBeApprovedForDemo(email, role) {
  return typeof email === 'string' && DEMO_APPROVED_EMAILS.has(email.toLowerCase()) && ['employer', 'agency'].includes(role);
}

/**
 * Maps a role to the function that creates its profile document.
 * Each function receives the active Mongoose session (so the write
 * joins the same transaction as the User insert), the new user's _id,
 * and the validated request body — same shape/contract as the old
 * PROFILE_INSERTERS map in the Postgres version, just Mongoose instead
 * of raw SQL.
 *
 * Request body fields stay snake_case (full_name, cv_url, etc.) — that's
 * the wire format validators/auth.validator.js already validates and
 * nothing about the DB swap should force every client integration to
 * change. Only the persistence layer underneath is camelCase now.
 */
const PROFILE_CREATORS = {
  seeker: async (session, userId, body) => {
    const [doc] = await Seeker.create(
      [{
        userId,
        fullName: body.full_name,
        cvUrl: body.cv_url || null,
        photoUrl: body.photo_url || null,
      }],
      { session },
    );
    return doc;
  },

  employer: async (session, userId, body) => {
    // EMP-04: logoUrl starts null — no logo_url is accepted at registration
    // anymore. It's set afterward via POST /api/v1/employers/logo, which
    // uploads a real image file and derives the URL itself.
    const [doc] = await Employer.create(
      [{
        userId,
        companyName: body.company_name,
        logoUrl: null,
        backofficePhone: body.backoffice_phone || null,
        promoDetails: body.promo_details || null,
        tinNumber: body.tin_number,
        subscriptionTier: body.subscription_tier,
      }],
      { session },
    );
    return doc;
  },

  agency: async (session, userId, body) => {
    const [doc] = await Agency.create(
      [{
        userId,
        agencyName: body.agency_name,
        operationalCity: body.operational_city || null,
        tinNumber: body.tin_number,
        subscriptionTier: body.subscription_tier,
      }],
      { session },
    );
    return doc;
  },
};

/**
 * Registers a new user + role-specific profile inside a single
 * MongoDB transaction (session.withTransaction), replacing the old
 * `withTransaction(pool)` helper. Rolls back entirely if either write
 * fails (e.g. duplicate phone, a profile validation error) — same
 * all-or-nothing guarantee the Postgres version had.
 *
 * Requires MONGODB_URI to point at a replica set: standalone MongoDB
 * instances don't support multi-document transactions. See
 * MIGRATION_NOTES.md for local dev setup.
 *
 * @param {object} body - Validated registration payload (see auth.validator.js)
 * @returns {Promise<{ user: object, profile: object, token: string }>}
 */
async function register(body) {
  const passwordHash = await bcrypt.hash(body.password, env.bcrypt.saltRounds);
  const session = await mongoose.startSession();

  let user;
  let profile;

  try {
    await session.withTransaction(async () => {
      const [createdUser] = await User.create(
        [{
          phone: body.phone || null,
          email: body.email || null,
          passwordHash,
          role: body.role,
          verificationStatus: shouldBeApprovedForDemo(body.email, body.role)
            ? 'approved'
            : ['employer', 'agency'].includes(body.role) ? 'payment_pending' : 'approved',
        }],
        { session },
      );
      user = createdUser;

      const createProfile = PROFILE_CREATORS[body.role];
      profile = await createProfile(session, user._id, body);
    });
  } catch (err) {
    // Mongo's duplicate-key error (E11000) is the direct equivalent of
    // Postgres' 23505 — translated here rather than in
    // errorHandler.middleware.js's generic catch-all so the message can
    // name which field collided.
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'value';
      throw new AppError(`A user with this ${field} already exists`, 409);
    }
    throw err;
  } finally {
    await session.endSession();
  }

  const token = signAccessToken(user);

  return { user: user.toJSON(), profile: profile.toJSON(), token };
}

/**
 * Authenticates a user by phone or email + password, and issues a JWT.
 *
 * @param {{ phone?: string, email?: string, password: string }} credentials
 * @returns {Promise<{ user: object, token: string }>}
 */
async function login({ phone, email, password }) {
  const identifiers = [];
  if (phone) identifiers.push({ phone });
  if (email) identifiers.push({ email });

  // `passwordHash` has `select: false` on the schema (see
  // models/User.model.js), so it must be opted back into explicitly
  // here — the one place that actually needs it.
  const user = await User.findOne({ $or: identifiers }).select('+passwordHash');
  if (!user) {
    throw new AppError('Invalid credentials', 401);
  }

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError('Invalid credentials', 401);
  }

  const token = signAccessToken(user);

  // .toJSON()'s transform strips passwordHash before this ever reaches
  // the controller — no manual `delete` needed, unlike the Postgres version.
  return { user: user.toJSON(), token };
}

module.exports = { register, login };
