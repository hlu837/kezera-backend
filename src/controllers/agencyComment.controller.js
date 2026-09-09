'use strict';

const agencyCommentService = require('../services/agencyComment.service');

/**
 * GET /api/v1/agencies/:agencyId/profile
 * Params validated upstream by validateParams(agencyIdParamSchema).
 */
async function getPublicProfileHandler(req, res, next) {
  try {
    const profile = await agencyCommentService.getPublicProfile(req.params.agencyId);
    return res.status(200).json({ status: 'success', data: { agency: profile } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/agencies/:agencyId/comments
 * Params validated upstream by validateParams(agencyIdParamSchema),
 * query validated upstream by validateQuery(listAgencyCommentsQuerySchema).
 */
async function listAgencyCommentsHandler(req, res, next) {
  try {
    const result = await agencyCommentService.listComments(req.params.agencyId, req.query);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /api/v1/agencies/:agencyId/comments
 * Params validated upstream by validateParams(agencyIdParamSchema),
 * body validated upstream by validateBody(createAgencyCommentSchema).
 */
async function createAgencyCommentHandler(req, res, next) {
  try {
    const comment = await agencyCommentService.createComment(
      req.user,
      req.params.agencyId,
      req.body,
    );
    return res.status(201).json({ status: 'success', data: { comment } });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/v1/agencies/:agencyId/comments/:commentId
 * Params validated upstream by validateParams(agencyCommentIdParamSchema).
 */
async function deleteAgencyCommentHandler(req, res, next) {
  try {
    await agencyCommentService.deleteComment(req.user, req.params.agencyId, req.params.commentId);
    return res.status(200).json({ status: 'success', data: null });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getPublicProfileHandler,
  listAgencyCommentsHandler,
  createAgencyCommentHandler,
  deleteAgencyCommentHandler,
};
