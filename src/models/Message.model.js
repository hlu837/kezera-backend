'use strict';

const { Schema, model } = require('mongoose');

const SENDER_ROLES = ['employer', 'agency', 'seeker'];

/**
 * EMP-02: a single message in a Placement's thread. The placement
 * itself IS the conversation — there's no separate Conversation
 * document, mirroring how the rest of this codebase keys agency/seeker
 * interactions off Placement rather than inventing a parallel entity.
 * Only the placement's two participants (the job's poster and the
 * matched seeker — see utils/placementAccess.js) can read or write to
 * a given thread.
 */
const messageSchema = new Schema(
  {
    placementId: {
      type: Schema.Types.ObjectId,
      ref: 'Placement',
      required: true,
      index: true,
    },
    senderId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Denormalized off the sender's role at send time (never trusted
    // from the request body — see messaging.service.js#sendMessage) so
    // the UI can render "Employer"/"Agency"/"You" labels without an
    // extra join back to Job/User on every message in a thread.
    senderRole: {
      type: String,
      enum: SENDER_ROLES,
      required: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    // null = unread by the recipient. Set once the OTHER participant
    // has listed the thread — see messaging.service.js#listMessages.
    // There is deliberately no separate "mark as read" endpoint.
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Thread pagination: every message for a placement, oldest first.
messageSchema.index({ placementId: 1, createdAt: 1 });

messageSchema.set('toJSON', {
  virtuals: true,
  transform: (_doc, ret) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    ret.placementId = ret.placementId.toString();
    ret.senderId = ret.senderId.toString();
    return ret;
  },
});

module.exports = model('Message', messageSchema);
module.exports.SENDER_ROLES = SENDER_ROLES;
