'use strict';

const {
  Message, Placement, Job, Seeker, Employer, Agency,
} = require('../models');
const AppError = require('../errors/AppError');
const { resolvePlacementForParticipant } = require('../utils/placementAccess');
const { enqueueNewMessageNotification } = require('../queues/notifications.queue');

/**
 * POST /api/v1/placements/:placementId/messages
 * Either participant (job poster or candidate) can send. `senderRole`
 * is derived from the resolved placement (job.creatorType for a
 * poster, always 'seeker' otherwise) rather than trusted off
 * `req.user.role` directly — an 'admin' caller resolves to whatever
 * `job.creatorType` actually is ('employer'/'agency'), so the stored
 * role always reflects the job's real posting side. Same "never trust
 * the client/token alone for a denormalized identity field" convention
 * as jobs.service.js#createJob's creatorId/creatorType.
 *
 * @param {string} userId - req.user.id
 * @param {string} role - req.user.role
 * @param {string} placementId
 * @param {string} body - already Joi-validated message text
 */
async function sendMessage(userId, role, placementId, body) {
  const { placement, job, viewerRole } = await resolvePlacementForParticipant(
    placementId,
    userId,
    role,
  );

  const senderRole = viewerRole === 'seeker' ? 'seeker' : job.creatorType;

  const message = await Message.create({
    placementId: placement.id,
    senderId: userId,
    senderRole,
    body,
  });

  try {
    await enqueueNewMessageNotification(message.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[messaging.service] failed to enqueue notification for message ${message.id}:`,
      err.message,
    );
  }

  return message.toJSON();
}

/**
 * GET /api/v1/placements/:placementId/messages
 * Full thread for a placement, oldest first. As a side effect, marks
 * every message from the OTHER participant as read — mirrors the
 * "opening a chat thread marks it read" convention most messaging UIs
 * use; there's deliberately no separate mark-as-read endpoint.
 *
 * @param {string} userId
 * @param {string} role
 * @param {string} placementId
 */
async function listMessages(userId, role, placementId) {
  await resolvePlacementForParticipant(placementId, userId, role); // throws if not a participant

  const messages = await Message.find({ placementId }).sort({ createdAt: 1 });

  const unreadFromOtherParty = messages.filter(
    (m) => m.senderId.toString() !== userId && !m.readAt,
  );
  if (unreadFromOtherParty.length > 0) {
    const now = new Date();
    await Message.updateMany(
      { _id: { $in: unreadFromOtherParty.map((m) => m._id) } },
      { $set: { readAt: now } },
    );
    unreadFromOtherParty.forEach((m) => { m.readAt = now; }); // reflect in the response without a re-fetch
  }

  return messages.map((doc) => doc.toJSON());
}

/**
 * GET /api/v1/admin/conversations
 * Read-only oversight queue: every placement that has at least one
 * message, newest activity first. Unlike `listMessages` above, this is
 * NOT scoped to the placement's two participants — admin needs to be
 * able to browse every employer/agency <-> seeker conversation on the
 * platform, so there's no `resolvePlacementForParticipant` check here.
 *
 * Built as a few targeted lookups rather than one giant `$lookup`
 * aggregation, since the volumes here (placements with messages) are
 * small enough that clarity wins over a single round trip.
 *
 * @param {{ page?: number, limit?: number }} [options]
 * @returns {Promise<{ conversations: Array<object>, page: number, limit: number, total: number }>}
 */
async function listConversationsForAdmin({ page = 1, limit = 20 } = {}) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const skip = (safePage - 1) * safeLimit;

  // Sort oldest->newest before grouping so $last inside $group actually
  // resolves to the most recent message per placement, not just
  // whichever document the pipeline happened to see last.
  const [grouped, totalResult] = await Promise.all([
    Message.aggregate([
      { $sort: { createdAt: 1 } },
      {
        $group: {
          _id: '$placementId',
          messageCount: { $sum: 1 },
          lastMessageAt: { $last: '$createdAt' },
          lastMessageBody: { $last: '$body' },
          lastMessageSenderRole: { $last: '$senderRole' },
        },
      },
      { $sort: { lastMessageAt: -1 } },
      { $skip: skip },
      { $limit: safeLimit },
    ]),
    Message.aggregate([{ $group: { _id: '$placementId' } }, { $count: 'total' }]),
  ]);
  const total = totalResult[0]?.total || 0;

  const placementIds = grouped.map((g) => g._id);
  const placements = await Placement.find({ _id: { $in: placementIds } }).lean();
  const placementById = new Map(placements.map((p) => [p._id.toString(), p]));

  const jobIds = placements.map((p) => p.jobId);
  const seekerIds = placements.map((p) => p.seekerId);

  const [jobs, seekers] = await Promise.all([
    Job.find({ _id: { $in: jobIds } }).select('title creatorId creatorType').lean(),
    Seeker.find({ _id: { $in: seekerIds } }).select('fullName').lean(),
  ]);
  const jobById = new Map(jobs.map((j) => [j._id.toString(), j]));
  const seekerById = new Map(seekers.map((s) => [s._id.toString(), s]));

  const employerCreatorIds = jobs
    .filter((j) => j.creatorType === 'employer')
    .map((j) => j.creatorId);
  const agencyCreatorIds = jobs
    .filter((j) => j.creatorType === 'agency')
    .map((j) => j.creatorId);

  const [employers, agencies] = await Promise.all([
    Employer.find({ userId: { $in: employerCreatorIds } }).select('userId companyName').lean(),
    Agency.find({ userId: { $in: agencyCreatorIds } }).select('userId agencyName').lean(),
  ]);
  const employerByUserId = new Map(employers.map((e) => [e.userId.toString(), e]));
  const agencyByUserId = new Map(agencies.map((a) => [a.userId.toString(), a]));

  const conversations = grouped.map((g) => {
    const placementId = g._id.toString();
    const placement = placementById.get(placementId);
    const job = placement ? jobById.get(placement.jobId.toString()) : null;
    const seeker = placement ? seekerById.get(placement.seekerId.toString()) : null;

    let posterName = null;
    if (job) {
      posterName = job.creatorType === 'employer'
        ? employerByUserId.get(job.creatorId.toString())?.companyName
        : agencyByUserId.get(job.creatorId.toString())?.agencyName;
    }

    return {
      placementId,
      jobTitle: job?.title || 'Unknown job',
      posterType: job?.creatorType || null,
      posterName: posterName || 'Unknown',
      seekerName: seeker?.fullName || 'Unknown',
      messageCount: g.messageCount,
      lastMessageAt: g.lastMessageAt,
      lastMessagePreview: g.lastMessageBody,
      lastMessageSenderRole: g.lastMessageSenderRole,
    };
  });

  return {
    conversations, page: safePage, limit: safeLimit, total,
  };
}

/**
 * GET /api/v1/admin/conversations/:placementId/messages
 * Full thread for a placement, read-only, for admin oversight.
 *
 * Deliberately does NOT reuse `listMessages` above: that function (a)
 * requires the caller to be one of the placement's two participants
 * (which an admin never is), and (b) marks the other party's messages
 * as read as a side effect of opening the thread — a rule that exists
 * to mirror normal "opening a chat marks it read" behavior for the
 * two people actually in the conversation, and would be wrong to run
 * for an admin who isn't a participant at all (it would falsely mark
 * messages as read for the real recipient).
 *
 * @param {string} placementId
 */
async function listMessagesForAdmin(placementId) {
  const placement = await Placement.findById(placementId).lean();
  if (!placement) {
    throw new AppError('Conversation not found', 404);
  }

  const [job, seeker, messages] = await Promise.all([
    Job.findById(placement.jobId).select('title creatorId creatorType').lean(),
    Seeker.findById(placement.seekerId).select('fullName').lean(),
    Message.find({ placementId }).sort({ createdAt: 1 }),
  ]);

  let posterName = null;
  if (job) {
    const Model = job.creatorType === 'employer' ? Employer : Agency;
    const nameField = job.creatorType === 'employer' ? 'companyName' : 'agencyName';
    const posterProfile = await Model.findOne({ userId: job.creatorId }).select(nameField).lean();
    posterName = posterProfile?.[nameField] || null;
  }

  return {
    placementId,
    jobTitle: job?.title || 'Unknown job',
    posterType: job?.creatorType || null,
    posterName: posterName || 'Unknown',
    seekerName: seeker?.fullName || 'Unknown',
    messages: messages.map((doc) => doc.toJSON()),
  };
}

module.exports = {
  sendMessage, listMessages, listConversationsForAdmin, listMessagesForAdmin,
};
