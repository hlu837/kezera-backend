'use strict';

const interviewsService = require('../services/interviews.service');
const messagingService = require('../services/messaging.service');

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

module.exports = {
  scheduleInterviewHandler,
  listInterviewsHandler,
  rescheduleInterviewHandler,
  updateInterviewStatusHandler,
  sendMessageHandler,
  listMessagesHandler,
};
