'use strict';

const { Schema, model } = require('mongoose');

const agencySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true, // one agency profile per user
    },
    agencyName: {
      type: String,
      required: true,
      trim: true,
    },
    ledgerBalance: {
      type: Number,
      default: 0, // running balance used by payout/withdrawal logic elsewhere
      min: 0,
    },
    operationalCity: {
      type: String,
      trim: true,
      default: null,
    },
    // Account-related contact number, editable from the agency's own
    // account screen (see agency.service.js#updateMyProfile) — mirrors
    // Employer.backofficePhone.
    backofficePhone: {
      type: String,
      trim: true,
      default: null,
    },
    tinNumber: {
      type: String,
      trim: true,
      default: null,
    },
    // Physical office address, editable from the agency's own account
    // screen alongside backofficePhone — shown in the "Find agencies
    // near you" quick-view sheet (nearby_agencies_map_screen.dart)
    // since operationalCity alone isn't specific enough to actually
    // find the office. Free text rather than structured
    // street/city/etc, same as Employer.model.js has no address field
    // to mirror — Ethiopian addresses commonly rely on landmarks/area
    // names rather than a strict postal format.
    address: {
      type: String,
      trim: true,
      default: null,
    },
    businessLicenseUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // Public-profile fields, editable from the agency's own account
    // screen — separate from the KYC/verification fields above
    // (tinNumber/businessLicenseUrl), which are set at registration and
    // reviewed by an admin. `bio` mirrors Employer.promoDetails; `logoUrl`
    // mirrors Employer.logoUrl and is only ever set server-side via the
    // logo upload endpoint (see agency.service.js#uploadLogo), never
    // accepted as a plain string field.
    bio: {
      type: String,
      trim: true,
      default: null,
    },
    logoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    // "Years in business" on the public directory/profile card — an
    // agency-supplied founding year (not this User's registration date
    // on the platform, which would understate how long the business
    // itself has actually operated). Optional: cards/profile simply
    // omit the "years in business" stat when unset, same degrade-
    // gracefully pattern as bio/logoUrl above.
    foundedYear: {
      type: Number,
      min: 1900,
      max: new Date().getFullYear(),
      default: null,
    },
    // Key of the `SubscriptionPlan` this agency is currently on (see
    // SubscriptionPlan.model.js). Not enum-restricted here — admin can
    // create/rename/delete plans at runtime, so validity is checked
    // against the live plan list where this is written, not baked into
    // the schema. Unrecognized/legacy values fall back to the default
    // plan wherever this is read (see subscriptionPlan.service.js).
    subscriptionTier: {
      type: String,
      trim: true,
      lowercase: true,
      default: 'basic',
    },
    // "Find agencies near you" — mirrors Seeker.model.js's
    // latitude/longitude/location trio exactly (see that file for the
    // full rationale). Plain numeric lat/lng for easy reading by API
    // consumers, plus a GeoJSON mirror kept in sync by
    // agency.service.js#updateLocation purely so the `2dsphere` index
    // below can answer $near queries. `null`/absent means this agency
    // has never set an office location, and it's simply excluded from
    // nearby-search results rather than sorted to the bottom.
    latitude: {
      type: Number,
      min: -90,
      max: 90,
      default: null,
    },
    longitude: {
      type: Number,
      min: -180,
      max: 180,
      default: null,
    },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude], GeoJSON order
        default: undefined,
      },
    },
  },
  {
    timestamps: true,
  },
);

// Sparse for the same reason as Seeker.model.js's identical index:
// `location` is only set once an agency has saved an office location,
// and a 2dsphere index over a field absent on most documents should
// stay sparse rather than indexing an implicit "no location" value.
agencySchema.index({ location: '2dsphere' }, { sparse: true });

agencySchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    // Stringify explicitly so downstream code can key/compare against
    // it as a plain string (e.g. notifications.service.js building a
    // Map keyed by user id) rather than a live ObjectId instance.
    if (ret.userId) {
      ret.userId = ret.userId.toString();
    }
    return ret;
  },
});

module.exports = model('Agency', agencySchema);
