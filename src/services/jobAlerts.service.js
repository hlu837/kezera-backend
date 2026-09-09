'use strict';

const {
  Job, SavedSearch, Seeker, User,
} = require('../models');
const { sendEmail } = require('./email.service');
const { sendSMS } = require('./sms.service');
const notificationService = require('./notification.service');
const { JOB_CATEGORIES } = require('../utils/jobCategories.taxonomy');
const AppError = require('../errors/AppError');

/**
 * Same "write the in-app row, but never let a failure here look like
 * the underlying SMS/email failed" wrapper as
 * notifications.service.js#writeInAppNotification — kept as its own
 * copy rather than a shared import since the two files' error-logging
 * prefixes intentionally differ per-module.
 */
async function writeInAppNotification(userId, type, title, body, data = {}) {
  try {
    await notificationService.create(userId, type, title, body, data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[jobAlerts.service] failed to write in-app notification (type=${type}, user_id=${userId}):`, err.message);
  }
}

/**
 * Tests whether a job matches a single saved search's criteria. Every
 * populated field on the saved search must match (AND semantics) —
 * an empty/unset field on the saved search is treated as "don't care"
 * and always passes, mirroring how jobs.service.js#browseJobs treats
 * absent query filters.
 *
 * @param {{ title: string, description: string, location: string, jobType: string, experienceLevel: string|null }} job
 * @param {{ keyword: string|null, location: string|null, jobType: string|null, experienceLevel: string|null }} savedSearch
 * @returns {boolean}
 */
function jobMatchesSavedSearch(job, savedSearch) {
  if (savedSearch.keyword) {
    const pattern = savedSearch.keyword.toLowerCase();
    const haystack = `${job.title} ${job.description}`.toLowerCase();
    if (!haystack.includes(pattern)) return false;
  }

  if (savedSearch.location) {
    if (!job.location || !job.location.toLowerCase().includes(savedSearch.location.toLowerCase())) {
      return false;
    }
  }

  if (savedSearch.jobType && job.jobType !== savedSearch.jobType) {
    return false;
  }

  if (savedSearch.experienceLevel && job.experienceLevel !== savedSearch.experienceLevel) {
    return false;
  }

  return true;
}

/**
 * Builds the "new job matches your saved search" alert email.
 *
 * @param {{ jobTitle: string, jobLocation: string, savedSearchName: string|null }} params
 * @returns {{ subject: string, htmlBody: string }}
 */
function buildAlertEmail({ jobTitle, jobLocation, savedSearchName }) {
  const subject = `New job matching your saved search: ${jobTitle}`;
  const label = savedSearchName ? `"${savedSearchName}"` : 'your saved search';
  const htmlBody = `
    <p>A new job matching ${label} was just posted on KeferaJobs.</p>
    <p><strong>${jobTitle}</strong> — ${jobLocation}</p>
    <p>Log in to your KeferaJobs account to view and apply.</p>
  `.trim();
  return { subject, htmlBody };
}

/**
 * Core JS-03 alert-preference handler, consumed by the
 * `NOTIFY_JOB_ALERTS` worker task. For a single newly-created job:
 *   1. Loads every alerts-enabled SavedSearch.
 *   2. Filters to the ones this job actually matches.
 *   3. Emails each matching saved search's owning seeker (deduped —
 *      one seeker with several matching saved searches for the same
 *      job gets a single email, not one per saved search).
 *   4. Stamps `lastAlertedAt` on every saved search that fired.
 *
 * A failure emailing one seeker never blocks the others
 * (Promise.allSettled), same resilience pattern as
 * notifications.service.js#dispatchCandidateAlerts.
 *
 * @param {string} jobId
 * @returns {Promise<{ matchedSavedSearches: number, seekersNotified: number, emailFailed: Array<{seekerId: string, reason: string}> }>}
 */
async function checkAndNotifySavedSearches(jobId) {
  if (!jobId) {
    throw new AppError('checkAndNotifySavedSearches requires a jobId', 422);
  }

  const job = await Job.findById(jobId).select(
    'title description location jobType experienceLevel status',
  );
  if (!job) {
    throw new AppError(`Job ${jobId} not found`, 404);
  }

  // Alerts only make sense for jobs a seeker could actually apply to.
  if (job.status !== 'open') {
    return { matchedSavedSearches: 0, seekersNotified: 0, emailFailed: [] };
  }

  const candidateSearches = await SavedSearch.find({ alertsEnabled: true });
  const matched = candidateSearches.filter((doc) => jobMatchesSavedSearch(job, doc));

  if (matched.length === 0) {
    return { matchedSavedSearches: 0, seekersNotified: 0, emailFailed: [] };
  }

  // One email per seeker, even if several of their saved searches
  // matched this job — group matched saved searches by seekerId.
  const bySeekerId = new Map();
  for (const savedSearch of matched) {
    const key = savedSearch.seekerId.toString();
    if (!bySeekerId.has(key)) bySeekerId.set(key, []);
    bySeekerId.get(key).push(savedSearch);
  }

  const seekerIds = [...bySeekerId.keys()];
  const seekers = await Seeker.find({ _id: { $in: seekerIds } }).select('userId');
  const userIdBySeekerId = new Map(seekers.map((s) => [s._id.toString(), s.userId.toString()]));

  const userIds = [...new Set([...userIdBySeekerId.values()])];
  const users = await User.find({ _id: { $in: userIds } }).select('email');
  const emailByUserId = new Map(users.map((u) => [u._id.toString(), u.email]));

  const results = await Promise.allSettled(
    seekerIds.map(async (seekerId) => {
      const userId = userIdBySeekerId.get(seekerId);
      const email = userId && emailByUserId.get(userId);
      if (!email) {
        // Not every seeker has an email on file (User.email is
        // nullable — phone-only accounts are valid). Skip, not a hard
        // failure worth crashing the batch over.
        throw new Error(`seeker ${seekerId} has no email on file`);
      }

      const savedSearches = bySeekerId.get(seekerId);
      const primary = savedSearches[0];
      const { subject, htmlBody } = buildAlertEmail({
        jobTitle: job.title,
        jobLocation: job.location,
        savedSearchName: primary.name,
      });
      await sendEmail({ to: email, subject, htmlBody });

      // Deliberately outside the try/throw path above: a failure here
      // must not register as an "emailFailed" entry for this seeker
      // (the email itself already succeeded), so it's fire-and-forget
      // via writeInAppNotification's own internal try/catch.
      await writeInAppNotification(
        userId,
        'job_alert',
        'New job alert',
        `A new job matching ${primary.name ? `"${primary.name}"` : 'your saved search'} was just posted: "${job.title}".`,
        { jobId },
      );

      return seekerId;
    }),
  );

  const emailFailed = results
    .map((result, i) => ({ result, seekerId: seekerIds[i] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, seekerId }) => ({
      seekerId,
      reason: result.reason?.message || String(result.reason),
    }));
  const seekersNotified = results.length - emailFailed.length;

  // Best-effort bookkeeping — stamp every matched saved search
  // (whether or not the email actually sent) so "last alert" reflects
  // when a match was found, not just successful delivery.
  await SavedSearch.updateMany(
    { _id: { $in: matched.map((doc) => doc._id) } },
    { $set: { lastAlertedAt: new Date() } },
  );

  // eslint-disable-next-line no-console
  console.log(
    `[jobAlerts.service] job_id=${jobId} matched_saved_searches=${matched.length} `
    + `seekers_notified=${seekersNotified}/${seekerIds.length}`,
  );

  return { matchedSavedSearches: matched.length, seekersNotified, emailFailed };
}

const CATEGORY_LABEL_BY_KEY = new Map(JOB_CATEGORIES.map((c) => [c.key, c.label]));

/**
 * Builds the category-match SMS body. Kept short — a shortcode SMS,
 * not the full job alert email `buildAlertEmail` builds — and
 * link-free like the other short-number sends (`notifications.service.js`
 * `buildCandidateSmsMessage`/`buildInterviewSmsMessage`), since the app
 * link itself doesn't fit a shortcode's charset/length assumptions.
 *
 * @param {{ jobTitle: string, categoryLabel: string, jobLocation: string }} params
 */
function buildCategorySmsMessage({ jobTitle, categoryLabel, jobLocation }) {
  return `New ${categoryLabel} job on KeferaJobs: "${jobTitle}" in ${jobLocation}. Open the app to apply.`;
}

/**
 * SEEK-01 category preferences -> instant SMS alert. For a single
 * newly-created job with a `category` set, texts every seeker whose
 * `preferredCategories` includes it — the promise made by the
 * onboarding screen's category picker (see `Seeker.model.js`'s comment
 * on `preferredCategories`), independent of and complementary to
 * `checkAndNotifySavedSearches` above (keyword/location/type/experience
 * level saved searches, emailed rather than texted). A seeker who both
 * opted into this job's category *and* has a matching saved search
 * gets both — they're unrelated preferences a seeker could set either,
 * neither, or both of.
 *
 * Same resilience shape as the rest of this file/notifications.service.js:
 * one bad phone number never blocks the batch (Promise.allSettled), and
 * a job with no category (legacy postings, or the field left blank) is
 * a no-op rather than an error, since there's nothing to match against.
 *
 * @param {string} jobId
 * @returns {Promise<{ matchedSeekers: number, smsSent: number, smsFailed: Array<{seekerId: string, reason: string}> }>}
 */
async function notifyPreferredCategorySeekers(jobId) {
  if (!jobId) {
    throw new AppError('notifyPreferredCategorySeekers requires a jobId', 422);
  }

  const job = await Job.findById(jobId).select('title location category status');
  if (!job) {
    throw new AppError(`Job ${jobId} not found`, 404);
  }

  // Same "only alert for jobs a seeker could actually apply to" guard
  // as checkAndNotifySavedSearches, plus: nothing to match a category
  // alert against if the posting was never categorized.
  if (job.status !== 'open' || !job.category) {
    return { matchedSeekers: 0, smsSent: 0, smsFailed: [] };
  }

  const seekers = await Seeker.find({ preferredCategories: job.category }).select('userId');
  if (seekers.length === 0) {
    return { matchedSeekers: 0, smsSent: 0, smsFailed: [] };
  }

  const userIds = seekers.map((s) => s.userId);
  const users = await User.find({ _id: { $in: userIds } }).select('phone');
  const phoneByUserId = new Map(users.map((u) => [u._id.toString(), u.phone]));

  const categoryLabel = CATEGORY_LABEL_BY_KEY.get(job.category) || job.category;
  const smsMessage = buildCategorySmsMessage({
    jobTitle: job.title,
    categoryLabel,
    jobLocation: job.location,
  });

  const results = await Promise.allSettled(
    seekers.map(async (seeker) => {
      const phone = phoneByUserId.get(seeker.userId.toString());
      if (!phone) {
        // Same "not every seeker has a phone on file" skip-not-fail
        // reasoning as notifications.service.js#dispatchCandidateAlerts.
        throw new Error(`seeker ${seeker._id} has no phone on file`);
      }
      await sendSMS({ to: phone, message: smsMessage });

      // Same "don't let this count as an SMS failure" reasoning as the
      // saved-search email path above.
      await writeInAppNotification(
        seeker.userId,
        'job_alert',
        'New job alert',
        `New ${categoryLabel} job on KeferaJobs: "${job.title}" in ${job.location}.`,
        { jobId },
      );

      return seeker._id.toString();
    }),
  );

  const smsFailed = results
    .map((result, i) => ({ result, seeker: seekers[i] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, seeker }) => ({
      seekerId: seeker._id.toString(),
      reason: result.reason?.message || String(result.reason),
    }));
  const smsSent = results.length - smsFailed.length;

  // eslint-disable-next-line no-console
  console.log(
    `[jobAlerts.service] job_id=${jobId} category=${job.category} matched_seekers=${seekers.length} `
    + `sms_sent=${smsSent}/${seekers.length}`,
  );

  return { matchedSeekers: seekers.length, smsSent, smsFailed };
}

module.exports = {
  checkAndNotifySavedSearches,
  jobMatchesSavedSearch,
  buildAlertEmail,
  notifyPreferredCategorySeekers,
};
