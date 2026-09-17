'use strict';

const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client } = require('../config/s3');
const env = require('../config/env');
const AppError = require('../errors/AppError');

/**
 * Uploads a buffer to S3 under the given key and returns its public URL.
 * Bucket access-control (public-read via bucket policy, or private +
 * signed URLs) is a deployment/infra concern and intentionally left out
 * of this call — we just PUT the object and hand back the canonical URL.
 *
 * @param {Buffer} buffer
 * @param {string} key - Full object key, e.g. "seekers/<userId>/cv/abc-resume.pdf"
 * @param {string} contentType
 * @returns {Promise<string>} the object's public URL
 */
async function uploadBuffer(buffer, key, contentType) {
  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[storage.service] S3 upload failed', err);
    throw new AppError('Failed to upload file to storage. Please try again.', 502);
  }

  return buildPublicUrl(key);
}

/**
 * Builds the object's public URL. Prefers a configured CDN/custom domain
 * (AWS_S3_PUBLIC_BASE_URL); falls back to a virtual-hosted-style S3 URL,
 * or a path-style URL when a custom endpoint (e.g. MinIO) is in use.
 *
 * @param {string} key
 * @returns {string}
 */
function buildPublicUrl(key) {
  if (env.s3.publicBaseUrl) {
    return `${env.s3.publicBaseUrl.replace(/\/+$/, '')}/${key}`;
  }
  if (env.s3.endpoint) {
    const base = env.s3.endpoint.replace(/\/+$/, '');
    return env.s3.forcePathStyle
      ? `${base}/${env.s3.bucket}/${key}`
      : `${base.replace('://', `://${env.s3.bucket}.`)}/${key}`;
  }
  return `https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com/${key}`;
}

module.exports = { uploadBuffer };
