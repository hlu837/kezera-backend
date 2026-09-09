'use strict';

const { Schema, model } = require('mongoose');

/**
 * Shared identity/auth collection for every role (mirrors the old SQL
 * `users` table). services/auth.service.js writes here first, then
 * fans out to the matching profile collection (Seeker/Employer/Agency)
 * in the same transaction.
 */
const userSchema = new Schema(
  {
    phone: {
      type: String,
      trim: true,
      unique: true,
      // `sparse` in addition to the spec's "unique, indexed": a plain
      // unique index would reject a second email-only account, since
      // Mongo would see two documents both matching phone: null/absent
      // as a duplicate. This mirrors the old Postgres column, which was
      // UNIQUE but nullable. See the pre-validate hook below for the
      // equivalent of that table's
      // `CHECK (phone IS NOT NULL OR email IS NOT NULL)` constraint.
      sparse: true,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      unique: true,
    },
    passwordHash: {
      type: String,
      required: true,
      // Never returned by default find/findOne queries — a stricter
      // guarantee than the old code's pattern of manually
      // `delete user.password_hash` before sending a response.
      // services/auth.service.js explicitly opts back in with
      // `.select('+passwordHash')` only where it's needed (login).
      select: false,
    },
    role: {
      type: String,
      enum: ['seeker', 'employer', 'agency', 'admin'],
      required: true,
    },
    // Derived, indexed lookup field: `phone` reduced to its last 9
    // digits, so smsInbound.service.js can resolve an inbound SMS
    // sender to a user via a plain indexed equality query, regardless
    // of which representation ("+251911234567", "0911234567",
    // "251911234567") the phone was stored in. Kept in sync by the
    // pre-save hook below rather than computed at query time — Mongo
    // has no built-in per-query regexp-strip+substring the way the old
    // `RIGHT(regexp_replace(phone, '\D', '', 'g'), 9)` SQL did, and
    // computing it per-query would mean scanning every user with a
    // phone on every inbound SMS instead of a single indexed lookup.
    phoneLast9: {
      type: String,
      default: null,
      index: true,
    },
    verificationStatus: {
      type: String,
      enum: ['payment_pending', 'pending', 'approved', 'rejected'],
      default: 'approved', // seekers and admins are approved by default
    },
    verificationRejectionReason: {
      type: String,
      default: null,
    },
    // Admin-controlled kill switch, orthogonal to verificationStatus:
    // verificationStatus is "did this account ever get approved to use
    // the platform" (a one-time onboarding gate), while accountStatus
    // is "can this already-approved account use it *right now*" — e.g.
    // an admin suspending an employer/agency mid-lifecycle over a
    // policy violation, well after they passed verification. See
    // requireApproved.middleware.js, which enforces this alongside (not
    // instead of) the verificationStatus checks, and
    // admin.service.js#setAccountStatus, the only place this is set.
    accountStatus: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
    },
    accountStatusReason: {
      type: String,
      default: null,
    },
    accountStatusUpdatedAt: {
      type: Date,
      default: null,
    },
    // "Last seen" for the employer/agency-facing candidate views
    // (searchSeekers, agency roster, job applications list,
    // suggested-seekers) — see middleware/auth.middleware.js's
    // touchLastActive, the only writer of this field. Kept on User
    // rather than Seeker/Employer/Agency since every role can be
    // "seen", not just seekers, even though seekers are the only role
    // it's currently surfaced for.
    lastActiveAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt, replacing the SQL created_at column
  },
);

// Equivalent of migration 001's
// `CHECK (phone IS NOT NULL OR email IS NOT NULL)` — a user must be
// reachable by at least one of phone/email to ever log in.
userSchema.pre('validate', function enforcePhoneOrEmail(next) {
  if (!this.phone && !this.email) {
    return next(new Error('User must have at least a phone number or an email address'));
  }
  return next();
});

// Keeps `phoneLast9` in sync whenever `phone` is set/changed. Runs on
// every save() (including the Model.create() calls auth.service.js
// makes during registration), which covers this app's only path that
// ever sets a user's phone — there's no "update my phone" endpoint.
userSchema.pre('save', function deriveLast9(next) {
  if (this.isModified('phone')) {
    this.phoneLast9 = this.phone ? String(this.phone).replace(/\D/g, '').slice(-9) || null : null;
  }
  return next();
});

userSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.passwordHash; // belt-and-suspenders on top of `select: false`
    return ret;
  },
});

module.exports = model('User', userSchema);
