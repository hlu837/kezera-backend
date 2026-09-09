'use strict';

const { Notification } = require('../models');
const AppError = require('../errors/AppError');

/**
 * NOTIF-01: writes one row to a user's in-app feed. Called from
 * whichever service already handles the underlying event — e.g.
 * `notifications.service.js#notifyNewMessage` calls this right after
 * (or alongside) sending the SMS/email for the same event, so the two
 * channels stay in sync without either one depending on the other's
 * success. Never throws on its own account being a "nice to have" —
 * callers wrap this the same way they already wrap the SMS/email calls,
 * so a failure to write a notification never blocks the primary action
 * (e.g. sending the message itself).
 *
 * @param {string} userId - recipient
 * @param {string} type - one of Notification.NOTIFICATION_TYPES
 * @param {string} title
 * @param {string} body
 * @param {object} [data] - deep-link payload (jobId, placementId, etc.)
 */
async function create(userId, type, title, body, data = {}) {
  const notification = await Notification.create({
    userId, type, title, body, data,
  });
  return notification.toJSON();
}

/**
 * GET /api/v1/notifications?page=&limit=&unread_only=
 * Newest first. `unreadCount` is returned alongside the page so the
 * frontend can refresh the bell badge off the same round trip
 * (`NotificationPage` on the Flutter side).
 *
 * @param {string} userId
 * @param {{ page?: number, limit?: number, unreadOnly?: boolean }} [opts]
 */
async function listForUser(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const filter = { userId };
  if (unreadOnly) filter.readAt = null;

  const skip = (page - 1) * limit;

  const [docs, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, readAt: null }),
  ]);

  return {
    notifications: docs.map((doc) => doc.toJSON()),
    total,
    unreadCount,
  };
}

/**
 * GET /api/v1/notifications/unread-count
 * Cheap poll for the bell badge without pulling the full feed.
 *
 * @param {string} userId
 */
async function getUnreadCount(userId) {
  const unreadCount = await Notification.countDocuments({ userId, readAt: null });
  return { unreadCount };
}

/**
 * PATCH /api/v1/notifications/:id/read
 * Scoped to `userId` in the query itself (not a separate ownership
 * check after fetching) so one user can never mark another's
 * notification read/leak its existence via a 200-vs-404 timing
 * difference — same "resolve and authorize in one query" shape as
 * `placementAccess.js`.
 *
 * @param {string} userId
 * @param {string} notificationId
 */
async function markAsRead(userId, notificationId) {
  const notification = await Notification.findOneAndUpdate(
    { _id: notificationId, userId },
    { $set: { readAt: new Date() } },
    { new: true },
  ).catch(() => null);

  if (!notification) {
    throw new AppError('Notification not found', 404);
  }

  return notification.toJSON();
}

/**
 * PATCH /api/v1/notifications/read-all
 * Marks every currently-unread notification for this user as read in
 * one write. Already-read rows are left untouched (their original
 * `readAt` is preserved rather than being bumped to now).
 *
 * @param {string} userId
 */
async function markAllAsRead(userId) {
  const result = await Notification.updateMany(
    { userId, readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { modifiedCount: result.modifiedCount };
}

/**
 * DELETE /api/v1/notifications
 * Clears the signed-in user's entire feed — read and unread alike, per
 * the frontend's "trash icon clears everything" toolbar action
 * (`NotificationsNotifier#deleteAll`).
 *
 * @param {string} userId
 */
async function deleteAllForUser(userId) {
  const result = await Notification.deleteMany({ userId });
  return { deletedCount: result.deletedCount };
}

module.exports = {
  create,
  listForUser,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteAllForUser,
};
