'use strict';

const notificationService = require('../services/notification.service');

/**
 * GET /api/v1/notifications?page=&limit=&unread_only=
 */
async function listNotificationsHandler(req, res, next) {
  try {
    const { page, limit, unread_only: unreadOnly } = req.query;
    const { notifications, total, unreadCount } = await notificationService.listForUser(
      req.user.id,
      { page, limit, unreadOnly },
    );
    return res.status(200).json({
      status: 'success',
      data: { notifications, total, unreadCount },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/v1/notifications/unread-count
 */
async function unreadCountHandler(req, res, next) {
  try {
    const { unreadCount } = await notificationService.getUnreadCount(req.user.id);
    return res.status(200).json({ status: 'success', data: { unreadCount } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/notifications/:id/read
 */
async function markAsReadHandler(req, res, next) {
  try {
    const notification = await notificationService.markAsRead(req.user.id, req.params.id);
    return res.status(200).json({ status: 'success', data: { notification } });
  } catch (err) {
    return next(err);
  }
}

/**
 * PATCH /api/v1/notifications/read-all
 */
async function markAllAsReadHandler(req, res, next) {
  try {
    const result = await notificationService.markAllAsRead(req.user.id);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

/**
 * DELETE /api/v1/notifications
 */
async function deleteAllHandler(req, res, next) {
  try {
    const result = await notificationService.deleteAllForUser(req.user.id);
    return res.status(200).json({ status: 'success', data: result });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listNotificationsHandler,
  unreadCountHandler,
  markAsReadHandler,
  markAllAsReadHandler,
  deleteAllHandler,
};
