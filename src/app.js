'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth.routes');
const seekerRoutes = require('./routes/seeker.routes');
const employerRoutes = require('./routes/employer.routes');
const agencyRoutes = require('./routes/agency.routes');
const agencyPublicRoutes = require('./routes/agencyPublic.routes');
const jobsRoutes = require('./routes/jobs.routes');
const placementsRoutes = require('./routes/placements.routes');
const interviewsRoutes = require('./routes/interviews.routes');
const webhooksRoutes = require('./routes/webhooks.routes');
const exampleProtectedRoutes = require('./routes/example-protected.routes');
const adminRoutes = require('./routes/admin.routes');
const verificationRoutes = require('./routes/verification.routes');
const paymentRoutes = require('./routes/payment.routes');
const notificationRoutes = require('./routes/notification.routes');
const adsRoutes = require('./routes/ads.routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler.middleware');

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Basic brute-force protection on auth endpoints specifically.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'error',
    message: 'Too many auth requests from this IP, please try again later.',
  },
});

app.get('/', (req, res) => res.status(200).json({ 
  status: 'ok', 
  message: 'Kezera Jobs Backend API',
  version: '1.0.0',
  docs: '/api/v1'
}));

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Inbound SMS gateway callbacks are unauthenticated by JWT (the caller
// is Twilio/Africa's Talking, not a logged-in user) and are protected
// instead by signature/secret verification inside webhooksRoutes. This
// rate limiter is a blunt backstop against a flood of forged/garbage
// requests reaching the DB before the (cheap) signature check even runs.
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many webhook requests, please try again shortly.' },
});

app.use('/api/v1/auth', authLimiter, authRoutes);
app.use('/api/v1/seekers', seekerRoutes);
app.use('/api/v1/employers', employerRoutes);
// Registered before agencyRoutes — see agencyPublic.routes.js's
// top-of-file note on why the order matters here.
app.use('/api/v1/agencies', agencyPublicRoutes);
app.use('/api/v1/agencies', agencyRoutes);
app.use('/api/v1/jobs', jobsRoutes);
app.use('/api/v1/placements', placementsRoutes);
app.use('/api/v1/interviews', interviewsRoutes);
app.use('/api/v1/webhooks', webhookLimiter, webhooksRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/verification', verificationRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/ads', adsRoutes);
app.use('/api/v1', exampleProtectedRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
