'use strict';

const { Schema, model } = require('mongoose');

/**
 * A public comment/review left on an agency's public profile — visible
 * to anyone (see agencyComment.service.js#listComments, which is a
 * public/unauthenticated read), postable by any logged-in seeker,
 * employer, or other agency who has dealt with this one.
 *
 * `agencyId` deliberately points at the Agency's *User* document
 * (`Agency.userId`), not `Agency._id` — this mirrors `Job.creatorId`,
 * which is also the agency's User id, so a comment thread can be
 * reached directly from a job posting (`job.creatorId`) without an
 * extra Agency lookup on the client.
 */
const agencyCommentSchema = new Schema(
  {
    agencyId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    authorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Snapshot of the author's role at post time — lets readers (and
    // agencyComment.service.js#attachAuthorInfo) tell a job seeker's
    // comment from another agency's without a second lookup against
    // User on every read.
    authorRole: {
      type: String,
      enum: ['seeker', 'employer', 'agency', 'admin'],
      required: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    // Optional 1-5 star rating attached to the comment. Nullable — a
    // plain comment with no rating is still a valid comment.
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Only read pattern: newest-first comments for one agency.
agencyCommentSchema.index({ agencyId: 1, createdAt: -1 });

agencyCommentSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.agencyId = ret.agencyId.toString();
    ret.authorId = ret.authorId.toString();
    return ret;
  },
});

module.exports = model('AgencyComment', agencyCommentSchema);
