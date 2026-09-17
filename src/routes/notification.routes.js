'use strict';

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { validateQuery, validateParams } = require('../middleware/validate.middleware');
const {
  notificationIdParamSchema,
  listNotificationsQuerySchema,
} = require('../validators/notification.validator');
const {
  listNotificationsHandler,
  unreadCountHandler,
  markAsReadHandler,
  markAllAsReadHandler,
  deleteAllHandler,
} = require('../controllers/notification.controller');

const router = Router();

// NOTIF-01: the in-app feed is shared by every role — scoping is
// entirely off `req.user.id` from the JWT (see notification.service.js),
// not a role gate here, same as placements.routes.js.
router.use(authenticate);

// GET /unread-count and PATCH /read-all before GET /:id-shaped routes
// aren't actually ambiguous here (neither collides with /:id/read), but
// kept in this order to read top-to-bottom the same way the frontend's
// NotificationsRepository lists them.
router.get('/', validateQuery(listNotificationsQuerySchema), listNotificationsHandler);
router.get('/unread-count', unreadCountHandler);
router.patch('/read-all', markAllAsReadHandler);
router.patch('/:id/read', validateParams(notificationIdParamSchema), markAsReadHandler);
router.delete('/', deleteAllHandler);

module.exports = router;
