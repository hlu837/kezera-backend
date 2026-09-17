'use strict';

const { S3Client } = require('@aws-sdk/client-s3');
const env = require('./env');

/**
 * Single shared S3 client, configured to work against either AWS S3
 * proper or any S3-compatible provider (DigitalOcean Spaces, MinIO,
 * Cloudflare R2, etc.) via S3_ENDPOINT / S3_FORCE_PATH_STYLE.
 */
const s3Client = new S3Client({
  region: env.s3.region,
  ...(env.s3.endpoint ? { endpoint: env.s3.endpoint } : {}),
  forcePathStyle: env.s3.forcePathStyle,
  credentials: {
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey,
  },
});

module.exports = { s3Client };
