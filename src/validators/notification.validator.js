'use strict';

const Joi = require('joi');

/** Shared MongoDB ObjectId shape check — same convention as placements.validator.js#objectId. */
const objectId = () => Joi.string().hex().length(24).messages({
  'string.hex': 'must be a valid MongoDB ObjectId',
  'string.length': 'must be a valid MongoDB ObjectId',
});

/** :id route param for PATCH /notifications/:id/read */
const notificationIdParamSchema = Joi.object({
  id: objectId().required(),
}).options({ abortEarly: false, stripUnknown: true });

/**
 * GET /api/v1/notifications?page=&limit=&unread_only=
 * Matches `NotificationsRepository.fetchNotifications`'s query params
 * exactly — `unread_only` on the wire, `unreadOnly` once it reaches the
 * service (see notification.controller.js).
 */
const listNotificationsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  unread_only: Joi.boolean().default(false),
}).options({ abortEarly: false, stripUnknown: true });

module.exports = {
  notificationIdParamSchema,
  listNotificationsQuerySchema,
};
