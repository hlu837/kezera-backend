'use strict';

/**
 * Centralized environment configuration.
 * Fails fast on boot if a required variable is missing, rather than
 * surfacing a confusing error later at request time.
 */

const REQUIRED_VARS = [
  'JWT_SECRET',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // MongoDB backs the newly-migrated User/Seeker/Employer/Agency models
  // and the auth endpoints in this task.
  'MONGODB_URI',
];


function requireEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

requireEnv();

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: process.env.JWT_ISSUER || 'keferajobs-api',
  },
  bcrypt: {
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '12', 10),
  },
  s3: {
    region: process.env.AWS_REGION,
    bucket: process.env.AWS_S3_BUCKET,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    // Only needed for non-AWS S3-compatible providers (MinIO, Spaces, R2...).
    endpoint: process.env.AWS_S3_ENDPOINT || null,
    forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
    // Optional CDN/custom domain fronting the bucket. Falls back to a
    // standard virtual-hosted-style S3 URL if not set.
    publicBaseUrl: process.env.AWS_S3_PUBLIC_BASE_URL || null,
  },
  upload: {
    maxFileSizeBytes: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5', 10) * 1024 * 1024,
  },
  redis: {
    // Not added to REQUIRED_VARS: only the matching worker process and
    // whatever enqueues onto it need Redis, not the whole API surface.
    // Defaults to a local dev Redis so `npm run dev` works out of the box.
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  matching: {
    // Default number of ranked candidates returned per JOB_MATCHING run.
    defaultTopN: parseInt(process.env.MATCHING_DEFAULT_TOP_N || '20', 10),
  },
  sms: {
    // Not added to REQUIRED_VARS for the same reason as redis: only the
    // notifications worker process needs these, not the whole API
    // surface. Missing/invalid credentials fail loudly at send-time
    // instead (see services/sms.service.js), which is where they'd
    // actually block something.
    provider: process.env.SMS_PROVIDER || 'twilio', // 'twilio' | 'africastalking'
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || null,
      authToken: process.env.TWILIO_AUTH_TOKEN || null,
      fromNumber: process.env.TWILIO_FROM_NUMBER || null,
    },
    africastalking: {
      apiKey: process.env.AT_API_KEY || null,
      username: process.env.AT_USERNAME || null,
      senderId: process.env.AT_SENDER_ID || null, // optional shortcode/alphanumeric sender
      // Africa's Talking has no cryptographic request-signing scheme for
      // inbound SMS callbacks, unlike Twilio's X-Twilio-Signature. The
      // standard workaround is a shared secret embedded in the callback
      // URL registered on the AT dashboard (e.g. .../sms/receive?provider=africastalking&secret=...),
      // checked in middleware/smsWebhookAuth.middleware.js.
      webhookSecret: process.env.AT_WEBHOOK_SECRET || null,
    },
  },
  email: {
    sendgridApiKey: process.env.SENDGRID_API_KEY || null,
    fromEmail: process.env.NOTIFICATIONS_FROM_EMAIL || 'notifications@keferajobs.com',
    fromName: process.env.NOTIFICATIONS_FROM_NAME || 'KeferaJobs',
  },
  // The exact public origin this app is reachable at (e.g.
  // "https://api.keferajobs.com"). Required to verify Twilio's inbound
  // webhook signature, which is computed over the *exact* URL Twilio
  // was configured to call — req.protocol/req.get('host') can't be
  // trusted for this since they're attacker-influenceable behind a
  // proxy unless "trust proxy" + proxy config is airtight.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  mongo: {
    // Must point at a replica set (even a single-node one in dev) —
    // Mongoose transactions (session.withTransaction, used by
    // services/auth.service.js) are a no-op error against a standalone
    // mongod. See MIGRATION_NOTES.md for a one-line local dev setup.
    uri: process.env.MONGODB_URI,
  },
  chapa: {
    secretKey: process.env.CHAPA_SECRET_KEY || 'CHASECK_TEST-placeholder',
    baseUrl: process.env.CHAPA_BASE_URL || 'https://api.chapa.co/v1',
  },
};
