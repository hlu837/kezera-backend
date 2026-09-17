'use strict';

const {
  ServiceRequest, Seeker, Technician, Agency,
} = require('../models');
const AppError = require('../errors/AppError');
const { enqueueServiceRequestNotification } = require('../queues/notifications.queue');

/**
 * Best-effort notification enqueue — same "create/mutate the row first,
 * enqueue after, catch the enqueue" shape as
 * applications.service.js#applyToJob. A misconfigured/unreachable SMS
 * or email provider (or a Redis blip) must never fail the request
 * itself.
 *
 * @param {string} serviceRequestId
 * @param {'created'|'assigned'|'accepted'|'declined'|'completed'|'cancelled'} event
 * @param {string|null} recipientUserId
 */
async function notify(serviceRequestId, event, recipientUserId) {
  if (!recipientUserId) return;
  try {
    await enqueueServiceRequestNotification(serviceRequestId, event, recipientUserId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[serviceRequests.service] failed to enqueue "${event}" notification for `
        + `service request ${serviceRequestId}:`,
      err.message,
    );
  }
}

/**
 * POST /api/v1/service-requests
 * A consumer (any authenticated role, acting as a homeowner/business
 * here rather than in their usual seeker/employer/agency capacity)
 * booking a one-off job from an Expert or an Agency, found via the
 * guest-facing `/seekers/nearby` or `/agencies/nearby` directories.
 *
 * @param {string} requesterId - req.user.id
 * @param {string} requesterRole - req.user.role, denormalized onto the row
 * @param {object} body - already Joi-validated (createServiceRequestSchema)
 * @returns {Promise<object>}
 */
async function createServiceRequest(requesterId, requesterRole, body) {
  const {
    targetType, targetSeekerId, targetTechnicianId, targetAgencyId, category, title,
    description, location, preferredDate, budget,
  } = body;

  let assignedSeekerId = null;
  let assignedTechnicianId = null;
  let recipientUserId = null;
  let status = 'pending';

  if (targetType === 'seeker') {
    // Direct request to one Expert picked off the map/directory —
    // assigned immediately, no separate assignment step (see the
    // ServiceRequest model's doc comment on `assignedSeekerId`).
    const seeker = await Seeker.findById(targetSeekerId).select('userId');
    if (!seeker) {
      throw new AppError('That expert could not be found', 404);
    }
    assignedSeekerId = seeker._id;
    recipientUserId = seeker.userId.toString();
    status = 'assigned';
  } else if (targetType === 'technician') {
    // Direct request to one Trade Technician picked off the "Find a
    // technician near you" map/directory — same immediate-assignment
    // shape as 'seeker' above, just against the Technician collection.
    const technician = await Technician.findById(targetTechnicianId).select('userId');
    if (!technician) {
      throw new AppError('That technician could not be found', 404);
    }
    assignedTechnicianId = technician._id;
    recipientUserId = technician.userId.toString();
    status = 'assigned';
  } else {
    // Routed to an Agency (not a specific person yet) — `targetAgencyId`
    // is the agency's own User id, same convention `agencyPublic`'s
    // `/nearby` already returns (see ServiceRequest model's doc comment
    // on `targetAgencyId`).
    const agency = await Agency.findOne({ userId: targetAgencyId }).select('_id');
    if (!agency) {
      throw new AppError('That agency could not be found', 404);
    }
    recipientUserId = targetAgencyId;
  }

  const serviceRequest = await ServiceRequest.create({
    requesterId,
    requesterRole,
    targetType,
    targetSeekerId: targetType === 'seeker' ? targetSeekerId : null,
    targetTechnicianId: targetType === 'technician' ? targetTechnicianId : null,
    targetAgencyId: targetType === 'agency' ? targetAgencyId : null,
    assignedSeekerId,
    assignedTechnicianId,
    category,
    title,
    description,
    location,
    preferredDate: preferredDate || null,
    budget: budget || null,
    status,
  });

  await notify(serviceRequest.id, 'created', recipientUserId);

  return serviceRequest.toJSON();
}

/**
 * GET /api/v1/service-requests/mine
 * The requester's own booking history, newest first, any role.
 *
 * @param {string} requesterId - req.user.id
 * @param {{ status?: string, page: number, limit: number }} filters
 */
async function listMyRequests(requesterId, filters) {
  const { status, page, limit } = filters;
  const query = { requesterId };
  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [requests, total] = await Promise.all([
    ServiceRequest.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ServiceRequest.countDocuments(query),
  ]);

  return {
    requests: requests.map((doc) => doc.toJSON()),
    page,
    limit,
    total,
  };
}

/**
 * GET /api/v1/service-requests/incoming
 * An Expert's or Agency's "requests for me" inbox — seeker-role callers
 * see everything currently `assignedSeekerId`'d to them (direct
 * requests and agency-assigned ones alike); agency-role callers see
 * everything `targetAgencyId`'d to them, before or regardless of
 * assignment, same split the two schema indexes on ServiceRequest.model.js
 * describe.
 *
 * @param {string} userId - req.user.id
 * @param {string} role - req.user.role — must be 'seeker' or 'agency'
 * @param {{ status?: string, page: number, limit: number }} filters
 */
async function listIncomingRequests(userId, role, filters) {
  const { status, page, limit } = filters;
  let query;

  if (role === 'seeker') {
    // A seeker-role account may hold a Seeker (CV) profile, a
    // Technician profile, or both (see Technician.model.js's
    // top-of-file note) — this inbox shows requests routed to
    // whichever one(s) they have, combined.
    const [seeker, technician] = await Promise.all([
      Seeker.findOne({ userId }).select('_id'),
      Technician.findOne({ userId }).select('_id'),
    ]);
    if (!seeker && !technician) {
      throw new AppError('Seeker profile not found', 404);
    }
    const or = [];
    if (seeker) or.push({ assignedSeekerId: seeker._id });
    if (technician) or.push({ assignedTechnicianId: technician._id });
    query = or.length === 1 ? or[0] : { $or: or };
  } else if (role === 'agency') {
    query = { targetAgencyId: userId };
  } else {
    throw new AppError('Only expert or agency accounts receive service requests', 403);
  }

  if (status) query.status = status;

  const skip = (page - 1) * limit;
  const [requests, total] = await Promise.all([
    ServiceRequest.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    ServiceRequest.countDocuments(query),
  ]);

  return {
    requests: requests.map((doc) => doc.toJSON()),
    page,
    limit,
    total,
  };
}

/**
 * POST /api/v1/service-requests/:id/assign
 * An Agency handing an agency-routed request to one of its own roster
 * seekers (mirrors `agency.service.js#dispatchCandidates` shortlisting
 * against a job). Only valid while the request is still unassigned —
 * covers both a brand-new agency-routed request and one reopened by a
 * decline (see `respondToRequest` below).
 *
 * @param {string} requestId
 * @param {string} agencyUserId - req.user.id of the authenticated agency
 * @param {string} seekerId
 */
async function assignToSeeker(requestId, agencyUserId, seekerId) {
  const serviceRequest = await ServiceRequest.findById(requestId);
  if (!serviceRequest) {
    throw new AppError('Service request not found', 404);
  }
  if (serviceRequest.targetType !== 'agency'
      || serviceRequest.targetAgencyId?.toString() !== agencyUserId) {
    throw new AppError('You do not have permission to assign this request', 403);
  }
  if (serviceRequest.status !== 'pending' || serviceRequest.assignedSeekerId) {
    throw new AppError('This request has already been assigned', 400);
  }

  const agency = await Agency.findOne({ userId: agencyUserId }).select('_id');
  if (!agency) {
    throw new AppError('Agency profile not found', 404);
  }

  // Must come from this agency's own roster — same ownership rule as
  // agency.service.js#listCandidates/dispatchCandidates.
  const seeker = await Seeker.findOne({ _id: seekerId, agencyId: agency._id }).select('userId');
  if (!seeker) {
    throw new AppError('That candidate is not part of your roster', 404);
  }

  serviceRequest.assignedSeekerId = seeker._id;
  serviceRequest.status = 'assigned';
  await serviceRequest.save();

  await notify(serviceRequest.id, 'assigned', seeker.userId.toString());

  return serviceRequest.toJSON();
}

/**
 * POST /api/v1/service-requests/:id/respond
 * The currently-assigned Expert accepting or declining a request.
 * Declining an agency-routed request reopens it for reassignment
 * (`assignedSeekerId` cleared, status back to `pending`) rather than
 * closing it outright — the requester's booking shouldn't die just
 * because the agency's first pick was busy. Declining a direct request
 * (the requester picked this Expert by name) is terminal — there's no
 * one else on file to fall back to.
 *
 * @param {string} requestId
 * @param {string} seekerUserId - req.user.id of the authenticated seeker
 * @param {'accept'|'decline'} action
 */
async function respondToRequest(requestId, seekerUserId, action) {
  // Same dual-profile lookup as listIncomingRequests above — the
  // responder may be answering as their Seeker profile or their
  // Technician profile, whichever this particular request was assigned
  // to.
  const [seeker, technician] = await Promise.all([
    Seeker.findOne({ userId: seekerUserId }).select('_id'),
    Technician.findOne({ userId: seekerUserId }).select('_id'),
  ]);
  if (!seeker && !technician) {
    throw new AppError('Seeker profile not found', 404);
  }

  const serviceRequest = await ServiceRequest.findById(requestId);
  if (!serviceRequest) {
    throw new AppError('Service request not found', 404);
  }
  const isAssignedSeeker = seeker
    && serviceRequest.assignedSeekerId?.toString() === seeker._id.toString();
  const isAssignedTechnician = technician
    && serviceRequest.assignedTechnicianId?.toString() === technician._id.toString();
  if (serviceRequest.status !== 'assigned' || (!isAssignedSeeker && !isAssignedTechnician)) {
    throw new AppError('This request is not awaiting your response', 400);
  }

  if (action === 'accept') {
    serviceRequest.status = 'accepted';
    serviceRequest.respondedAt = new Date();
  } else if (serviceRequest.targetType === 'agency') {
    serviceRequest.assignedSeekerId = null;
    serviceRequest.status = 'pending';
  } else {
    serviceRequest.status = 'declined';
    serviceRequest.respondedAt = new Date();
  }

  await serviceRequest.save();

  await notify(
    serviceRequest.id,
    action === 'accept' ? 'accepted' : 'declined',
    serviceRequest.requesterId.toString(),
  );
  // The agency also needs to know a decline happened so it can
  // reassign — the requester notification above covers the requester,
  // this one is the agency's own inbox update.
  if (action === 'decline' && serviceRequest.targetType === 'agency') {
    await notify(serviceRequest.id, 'declined', serviceRequest.targetAgencyId.toString());
  }

  return serviceRequest.toJSON();
}

/**
 * PATCH /api/v1/service-requests/:id/status
 * Marking a booking `completed` (only reachable from `accepted`) or
 * `cancelled` (reachable from any non-terminal status). Either side of
 * the booking may act — the requester (closing out or calling off their
 * own booking) or whoever is currently on the hook to do the work (the
 * assigned Expert directly, or the Agency it was routed to) — same
 * "either participant" reasoning as `utils/placementAccess.js` applies
 * to placement-scoped actions.
 *
 * @param {string} requestId
 * @param {string} userId - req.user.id
 * @param {'completed'|'cancelled'} status
 */
async function updateRequestStatus(requestId, userId, status) {
  const serviceRequest = await ServiceRequest.findById(requestId);
  if (!serviceRequest) {
    throw new AppError('Service request not found', 404);
  }

  const isRequester = serviceRequest.requesterId.toString() === userId;
  const isTargetAgency = serviceRequest.targetAgencyId?.toString() === userId;
  let isAssignedSeeker = false;
  if (!isRequester && !isTargetAgency && serviceRequest.assignedSeekerId) {
    const seeker = await Seeker.findOne({ userId }).select('_id');
    isAssignedSeeker = !!seeker
      && serviceRequest.assignedSeekerId.toString() === seeker._id.toString();
  }
  let isAssignedTechnician = false;
  if (!isRequester && !isTargetAgency && !isAssignedSeeker && serviceRequest.assignedTechnicianId) {
    const technician = await Technician.findOne({ userId }).select('_id');
    isAssignedTechnician = !!technician
      && serviceRequest.assignedTechnicianId.toString() === technician._id.toString();
  }

  if (!isRequester && !isTargetAgency && !isAssignedSeeker && !isAssignedTechnician) {
    throw new AppError('You do not have permission to update this request', 403);
  }

  if (status === 'completed') {
    if (serviceRequest.status !== 'accepted') {
      throw new AppError('Only an accepted request can be marked completed', 400);
    }
    serviceRequest.status = 'completed';
    serviceRequest.completedAt = new Date();
  } else {
    if (['completed', 'cancelled', 'declined'].includes(serviceRequest.status)) {
      throw new AppError('This request can no longer be cancelled', 400);
    }
    serviceRequest.status = 'cancelled';
    serviceRequest.cancelledAt = new Date();
    serviceRequest.cancelledBy = userId;
  }

  await serviceRequest.save();

  // Notify whichever side didn't make the change.
  let recipientUserId = serviceRequest.requesterId.toString();
  if (isRequester) {
    if (serviceRequest.assignedSeekerId) {
      recipientUserId = (
        await Seeker.findById(serviceRequest.assignedSeekerId).select('userId')
      )?.userId?.toString();
    } else if (serviceRequest.assignedTechnicianId) {
      recipientUserId = (
        await Technician.findById(serviceRequest.assignedTechnicianId).select('userId')
      )?.userId?.toString();
    } else {
      recipientUserId = serviceRequest.targetAgencyId?.toString();
    }
  }

  await notify(serviceRequest.id, status, recipientUserId);

  return serviceRequest.toJSON();
}

module.exports = {
  createServiceRequest,
  listMyRequests,
  listIncomingRequests,
  assignToSeeker,
  respondToRequest,
  updateRequestStatus,
};
