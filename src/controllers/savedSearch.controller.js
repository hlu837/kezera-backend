'use strict';

const savedSearchService = require('../services/savedSearch.service');

/**
 * POST /api/v1/seekers/saved-searches
 * Body validated upstream by validateBody(createSavedSearchSchema).
 */
async function createHandler(req, res, next) {
  try {
    const savedSearch = await savedSearchService.createSavedSearch(req.user.id, req.body);
    return res.status(201).json({ status: 'success', data: { saved_search: savedSearch } });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/seekers/saved-searches
 */
async function listHandler(req, res, next) {
  try {
    const savedSearches = await savedSearchService.listSavedSearches(req.user.id);
    return res.status(200).json({
      status: 'success',
      data: { saved_searches: savedSearches, count: savedSearches.length },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/seekers/saved-searches/:id
 * Params validated upstream by validateParams(savedSearchIdParamSchema),
 * body validated upstream by validateBody(updateSavedSearchSchema).
 */
async function updateHandler(req, res, next) {
  try {
    const savedSearch = await savedSearchService.updateSavedSearch(
      req.user.id,
      req.params.id,
      req.body,
    );
    return res.status(200).json({ status: 'success', data: { saved_search: savedSearch } });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/v1/seekers/saved-searches/:id
 * Params validated upstream by validateParams(savedSearchIdParamSchema).
 */
async function deleteHandler(req, res, next) {
  try {
    await savedSearchService.deleteSavedSearch(req.user.id, req.params.id);
    return res.status(200).json({ status: 'success', data: null });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  createHandler,
  listHandler,
  updateHandler,
  deleteHandler,
};
