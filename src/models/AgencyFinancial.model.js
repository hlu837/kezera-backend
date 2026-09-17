'use strict';

const { Schema, model } = require('mongoose');

const TRANSACTION_TYPES = ['registration_fee', 'commission'];

/**
 * Task 7 (Agency Dispatches & Daily Financial Ledger): one row per
 * financial event on an agency's books — a walk-in candidate's
 * registration fee collected at the desk, or a commission earned on a
 * successful placement. `Agency.ledgerBalance` (see Agency.model.js) is
 * the running total; every write to this collection goes through
 * agency.service.js#recordLedgerEntry, which atomically keeps that
 * running total in sync with the entries here (see that function's
 * doc comment for the sign convention).
 */
const agencyFinancialSchema = new Schema(
  {
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: 'Agency',
      required: true,
      // Every ledger read in this app (daily entries list, dashboard
      // stats aggregation) is scoped to "this agency's own entries",
      // so this is the primary lookup path.
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      // Always stored as a positive magnitude — `transactionType` (not
      // sign) determines whether it increases or decreases
      // `ledgerBalance`. Keeps aggregation ($sum) and display
      // unambiguous rather than relying on callers to remember to
      // negate commissions.
      min: 0,
    },
    transactionType: {
      type: String,
      enum: TRANSACTION_TYPES,
      required: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: null,
    },
    // Deliberately a plain `date` field (defaulting to now) distinct
    // from `createdAt`/`updatedAt` below: this is the accounting date
    // the entry is booked against (a desk worker backfilling a fee
    // collected earlier today should be able to set it explicitly),
    // whereas `createdAt` is purely "when this document was written".
    // Daily aggregations (dashboard stats) filter/group on THIS field.
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Dashboard stats' daily aggregation groups by (agencyId, date range) —
// mirrors the compound access pattern of Seeker's
// { availabilityStatus, city } index elsewhere in this codebase.
agencyFinancialSchema.index({ agencyId: 1, date: -1 });

agencyFinancialSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    if (ret.agencyId) {
      ret.agencyId = ret.agencyId.toString();
    }
    return ret;
  },
});

module.exports = model('AgencyFinancial', agencyFinancialSchema);
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
