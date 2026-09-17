'use strict';

/**
 * Reference implementation only — shows how other feature modules
 * (jobs, placements, billing, etc.) should compose the auth middleware.
 * Not required by the auth module itself; safe to delete or adapt.
 */

const { Router } = require('express');
const { authenticate } = require('../middleware/auth.middleware');
const { authorizeRoles } = require('../middleware/rbac.middleware');

const router = Router();

// Any authenticated user, regardless of role.
router.get('/me', authenticate, (req, res) => {
  res.status(200).json({ status: 'success', data: { user: req.user } });
});

// Only employers and agencies may post jobs.
router.post('/jobs', authenticate, authorizeRoles('employer', 'agency'), (req, res) => {
  res.status(201).json({ status: 'success', message: 'Job created (example handler)' });
});

// Admin-only route.
router.get('/admin/dashboard', authenticate, authorizeRoles('admin'), (req, res) => {
  res.status(200).json({ status: 'success', message: 'Welcome, admin (example handler)' });
});

module.exports = router;
