'use strict';

const interviewsService = require('../services/interviews.service');
const messagingService = require('../services/messaging.service');
const placementsService = require('../services/placements.service');
const Job = require('../models/Job.model');
const Agency = require('../models/Agency.model');
const AppError = require('../errors/AppError');

/**
 * POST /api/v1/placements/:placementId/interviews
 * Body validated upstream by validateBody(scheduleInterviewSchema).
 */
async function scheduleInterviewHandler(req, res, next) {
  try {
    const interview = await interviewsService.scheduleInterview(
      req.user.id,
      req.user.role,
      req.params.placementId,
      req.body,
    );
    return res.status(201).json({ status: 'success', data: { interview } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/placements/:placementId/interviews
 */
async function listInterviewsHandler(req, res, next) {
  try {
    const interviews = await interviewsService.listInterviewsForPlacement(
      req.user.id,
      req.user.role,
      req.params.placementId,
    );
    return res.status(200).json({ status: 'success', data: { interviews } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/interviews/:id
 * Body validated upstream by validateBody(rescheduleInterviewSchema).
 */
async function rescheduleInterviewHandler(req, res, next) {
  try {
    const interview = await interviewsService.rescheduleInterview(
      req.user.id,
      req.user.role,
      req.params.id,
      req.body,
    );
    return res.status(200).json({ status: 'success', data: { interview } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/interviews/:id/status
 * Body validated upstream by validateBody(updateInterviewStatusSchema).
 */
async function updateInterviewStatusHandler(req, res, next) {
  try {
    const interview = await interviewsService.updateInterviewStatus(
      req.user.id,
      req.user.role,
      req.params.id,
      req.body.status,
    );
    return res.status(200).json({ status: 'success', data: { interview } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/placements/:placementId/messages
 * Body validated upstream by validateBody(sendMessageSchema).
 */
async function sendMessageHandler(req, res, next) {
  try {
    const message = await messagingService.sendMessage(
      req.user.id,
      req.user.role,
      req.params.placementId,
      req.body.body,
    );
    return res.status(201).json({ status: 'success', data: { message } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/placements/:placementId/messages
 */
async function listMessagesHandler(req, res, next) {
  try {
    const messages = await messagingService.listMessages(
      req.user.id,
      req.user.role,
      req.params.placementId,
    );
    return res.status(200).json({ status: 'success', data: { messages } });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/placements/invite
 * Body validated upstream by validateBody(inviteCandidateSchema).
 *
 * "Send Job Request" on the Experts map/directory: an employer or
 * agency picks one of their own job postings and a seeker found via
 * `/seekers/nearby` (or any other search), and this upserts a
 * `matched`-status Placement linking them — exactly what
 * `placements.service.js#inviteCandidate` was already written for
 * ("just triggered by a person clicking 'Message' on a search result")
 * but that was never wired to a route until now. The returned
 * placementId is also the messaging thread key, so the client can jump
 * straight into `PlacementChatScreen` (the "Chat" action) right after.
 *
 * Ownership mirrors agency.service.js#dispatchCandidates: the job must
 * belong to the caller (creatorId === req.user.id) and its creatorType
 * must match the caller's role, so an employer can't invite candidates
 * against an agency's posting or vice versa.
 */
async function inviteCandidateHandler(req, res, next) {
  try {
    const { jobId, seekerId } = req.body;
    const job = await Job.findById(jobId).select('creatorId creatorType');
    if (!job || job.creatorId.toString() !== req.user.id || job.creatorType !== req.user.role) {
      // Deliberately vague, mirroring dispatchCandidates: don't reveal
      // whether the job exists but belongs to someone else.
      throw new AppError('Job not found or you do not have permission to invite for it', 404);
    }

    let agencyId = null;
    if (req.user.role === 'agency') {
      const agency = await Agency.findOne({ userId: req.user.id }).select('_id');
      if (!agency) {
        throw new AppError('Agency profile not found for the authenticated user', 404);
      }
      agencyId = agency._id;
    }

    const placementId = await placementsService.inviteCandidate(jobId, agencyId, seekerId);
    return res.status(201).json({ status: 'success', data: { placementId } });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  scheduleInterviewHandler,
  listInterviewsHandler,
  rescheduleInterviewHandler,
  updateInterviewStatusHandler,
  sendMessageHandler,
  listMessagesHandler,
  inviteCandidateHandler,
};
