'use strict';

const Joi = require('joi');
const { AD_ICONS } = require('../models/Ad.model');

/** POST /api/v1/ads */
const createAdSchema = Joi.object({
  title: Joi.string().trim().min(2).max(60).required(),
  subtitle: Joi.string().trim().min(2).max(140).required(),
  icon: Joi.string().valid(...AD_ICONS).optional(),
  link_url: Joi.string().uri({ scheme: ['http', 'https'] }).optional(),
}).options({ abortEarly: false, stripUnknown: true });

/** POST /api/v1/admin/ads/:adId/reject */
const rejectAdSchema = Joi.object({
  reason: Joi.string().trim().min(2).max(1000).required(),
});

/** GET /api/v1/admin/ads?status=pending_review */
const listAdsQuerySchema = Joi.object({
  status: Joi.string().valid('draft', 'pending_review', 'active', 'rejected', 'expired').optional(),
});

module.exports = { createAdSchema, rejectAdSchema, listAdsQuerySchema };
