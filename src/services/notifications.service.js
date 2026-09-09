'use strict';

const {
  Job, User, Employer, Agency, Interview, Message, Seeker, Placement, Application,
} = require('../models');
const { sendSMS } = require('./sms.service');
const { sendEmail } = require('./email.service');
const notificationService = require('./notification.service');
const AppError = require('../errors/AppError');

/**
 * Writes the in-app feed row for an event alongside whatever SMS/email
 * this file already sends for it. Swallows its own errors (logged, not
 * thrown) so a notification-write failure never sinks the SMS/email
 * send it's paired with — same "one channel's failure doesn't block
 * another" resilience already used throughout this file.
 *
 * @param {string} userId
 * @param {string} type
 * @param {string} title
 * @param {string} body
 * @param {object} [data]
 */
async function writeInAppNotification(userId, type, title, body, data = {}) {
  try {
    await notificationService.create(userId, type, title, body, data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] failed to write in-app notification (type=${type}, user_id=${userId}):`, err.message);
  }
}

/**
 * Loads the fields needed to build both notification messages: the
 * job's title, and the display name + contact email of whichever
 * account posted it (employer or agency, per `job.creatorType`).
 *
 * @param {string} jobId
 * @returns {Promise<{ jobTitle: string, creatorId: string, creatorType: 'employer'|'agency', posterName: string, posterEmail: string|null }>}
 */
async function getJobAndPosterContact(jobId) {
  const job = await Job.findById(jobId).select('title creatorId creatorType');
  if (!job) {
    throw new AppError(`Job ${jobId} not found`, 404);
  }

  const [poster, profile] = await Promise.all([
    User.findById(job.creatorId).select('email'),
    job.creatorType === 'employer'
      ? Employer.findOne({ userId: job.creatorId }).select('companyName')
      : Agency.findOne({ userId: job.creatorId }).select('agencyName'),
  ]);

  return {
    jobTitle: job.title,
    creatorId: job.creatorId.toString(),
    creatorType: job.creatorType,
    // Falls back to a generic label rather than sending a blank/"null"
    // employer name in the SMS if the profile's name field was never filled in.
    posterName: (profile && (profile.companyName || profile.agencyName)) || 'a KeferaJobs employer',
    posterEmail: poster?.email || null,
  };
}

/**
 * Batch-resolves phone numbers for a list of candidates by their
 * `userId` (candidates come from matching.service's ranked output,
 * which carries `userId` but not `phone` — phone lives on `User`).
 * One query for the whole batch instead of N, so dispatching to a
 * large shortlist doesn't fan out into dozens of round trips.
 *
 * @param {string[]} userIds
 * @returns {Promise<Map<string, string|null>>} userId -> phone (or null if unset)
 */
async function getPhonesByUserId(userIds) {
  if (userIds.length === 0) return new Map();

  const users = await User.find({ _id: { $in: userIds } }).select('phone');

  return new Map(users.map((user) => [user._id.toString(), user.phone]));
}

/**
 * Builds the candidate SMS body. Kept as its own function so the copy
 * can be tuned/localized in one place.
 *
 * @param {string} employerName
 * @returns {string}
 */
function buildCandidateSmsMessage(employerName) {
  return `New matching job available at ${employerName}! Reply 1 to Accept.`;
}

/**
 * Batch-resolves the owning agency (if any) for a list of seekerIds —
 * i.e. seekers registered through an agency's walk-in flow (see
 * agency.service.js#registerWalkIn), which stamps `Seeker.agencyId`.
 * Seekers who signed up on their own have no owning agency and are
 * simply absent from the returned map.
 *
 * @param {string[]} seekerIds
 * @returns {Promise<Map<string, string>>} seekerId -> agencyId (Agency._id, as a string)
 */
async function getAgencyOwnersBySeekerId(seekerIds) {
  if (seekerIds.length === 0) return new Map();

  const seekers = await Seeker.find({
    _id: { $in: seekerIds },
    agencyId: { $ne: null },
  }).select('agencyId');

  return new Map(seekers.map((s) => [s._id.toString(), s.agencyId.toString()]));
}

/**
 * Builds the "your candidate(s) matched" email sent to an agency that
 * did NOT post the job itself, when one or more seekers it registered
 * got matched to someone else's posting. Kept separate from
 * buildPosterEmail's own-roster callout below so an agency that IS the
 * poster gets one combined email, not two, for the same match event.
 *
 * @param {{ jobTitle: string, posterName: string, candidateNames: string[] }} params
 */
function buildRosterMatchEmail({ jobTitle, posterName, candidateNames }) {
  const count = candidateNames.length;
  const subject = `${count} of your candidate${count === 1 ? '' : 's'} matched "${jobTitle}"`;
  const htmlBody = `
    <p>${count === 1 ? 'A candidate' : `${count} candidates`} from your roster
       matched a new job posting at ${posterName}.</p>
    <p>Job: <strong>${jobTitle}</strong></p>
    <p>Candidate${count === 1 ? '' : 's'}: <strong>${candidateNames.join(', ')}</strong></p>
    <p>Log in to your KeferaJobs dashboard to view the details.</p>
  `.trim();
  return { subject, htmlBody };
}

/**
 * Builds the employer/agency summary email (subject + HTML body).
 *
 * @param {{ count: number, jobTitle: string, ownRosterNames?: string[] }} params
 *   ownRosterNames - when the poster is itself an agency, the subset
 *   of matched candidates that are also on that agency's own roster
 *   (see dispatchCandidateAlerts) — called out inline so the poster
 *   doesn't have to guess which of the N matches are candidates it
 *   registered itself vs. from the general pool.
 * @returns {{ subject: string, htmlBody: string }}
 */
function buildPosterEmail({ count, jobTitle, ownRosterNames = [] }) {
  const subject = `${count} pre-screened candidate${count === 1 ? '' : 's'} ready for review`;
  const rosterLine = ownRosterNames.length > 0
    ? `<p><strong>${ownRosterNames.length} of these ${ownRosterNames.length === 1 ? 'is' : 'are'} from your own roster:</strong> ${ownRosterNames.join(', ')}.</p>`
    : '';
  const htmlBody = `
    <p>Agency sent ${count} pre-screened candidate${count === 1 ? '' : 's'} for your review.</p>
    <p>Job: <strong>${jobTitle}</strong></p>
    ${rosterLine}
    <p>Log in to your KeferaJobs dashboard to view the shortlist.</p>
  `.trim();
  return { subject, htmlBody };
}

/**
 * Dispatches notifications for a completed matching run:
 *   1. SMS to every matched candidate ("New matching job available...").
 *   2. One summary email to the job's poster (employer or agency),
 *      calling out any matched candidates that are also on the
 *      poster's own agency roster.
 *   3. A separate "your candidate(s) matched" email + in-app
 *      notification to any OTHER agency (not the poster) that owns one
 *      or more of the matched candidates — e.g. a job posted by an
 *      employer, or by a different agency, matched a seeker this
 *      agency registered via walk-in.
 *
 * Designed to be called as a background task (e.g. from a BullMQ
 * worker — see workers/notifications.worker.js) rather than inline on
 * a request path, since a shortlist can be dozens of candidates and
 * SMS/email providers are external calls with their own latency and
 * failure modes.
 *
 * A failure sending to one candidate never blocks the others —
 * `Promise.allSettled` is used so one bad phone number or a transient
 * provider error doesn't sink the whole batch. The poster email is
 * still sent even if every SMS failed, since "candidates were matched"
 * remains true regardless of whether they could be reached by SMS.
 *
 * @param {string} jobId
 * @param {Array<{ seekerId: string, userId: string, fullName?: string }>} candidateList
 *   Ranked candidates, typically `matchCandidatesForJob(...).candidates`
 *   or the equivalent docs persisted to `Placement`.
 * @returns {Promise<{
 *   smsAttempted: number,
 *   smsSent: number,
 *   smsFailed: Array<{ seekerId: string, reason: string }>,
 *   posterEmailSent: boolean,
 *   posterEmailError: string|null,
 *   rosterAgenciesNotified: number,
 * }>}
 */
async function dispatchCandidateAlerts(jobId, candidateList) {
  if (!jobId) {
    throw new AppError('dispatchCandidateAlerts requires a jobId', 422);
  }
  const candidates = candidateList || [];

  const {
    jobTitle, posterName, posterEmail, creatorId,
  } = await getJobAndPosterContact(jobId);
  const smsMessage = buildCandidateSmsMessage(posterName);

  const phonesByUserId = await getPhonesByUserId(
    candidates.map((c) => c.userId).filter(Boolean),
  );

  const smsResults = await Promise.allSettled(
    candidates.map(async (candidate) => {
      const phone = phonesByUserId.get(candidate.userId);
      if (!phone) {
        // Not every seeker is guaranteed a phone on file (User.phone
        // is nullable — email-only accounts are valid). Treat as a
        // skip, not a hard failure worth crashing the batch over.
        throw new Error(`seeker ${candidate.seekerId} has no phone on file`);
      }
      await sendSMS({ to: phone, message: smsMessage });
      return candidate.seekerId;
    }),
  );

  const smsFailed = smsResults
    .map((result, i) => ({ result, candidate: candidates[i] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, candidate }) => ({
      seekerId: candidate.seekerId,
      reason: result.reason?.message || String(result.reason),
    }));
  const smsSent = smsResults.length - smsFailed.length;

  // In-app "job_match" row for every candidate — unlike the SMS above,
  // this doesn't need a phone on file, so it's not gated on the same
  // per-candidate lookup/skip logic.
  await Promise.allSettled(
    candidates
      .filter((candidate) => candidate.userId)
      .map((candidate) => writeInAppNotification(
        candidate.userId,
        'job_match',
        'New job match',
        `You've been matched to "${jobTitle}" at ${posterName}.`,
        { jobId },
      )),
  );

  // Which of these matched candidates were registered by an agency
  // (Seeker.agencyId) — that agency gets told specifically, rather
  // than having to infer it from the poster's generic "N candidates
  // matched" count. An agency can own matched candidates on ANY job,
  // not just ones it posted itself, so this always runs.
  let ownRosterNames = [];
  let rosterAgenciesNotified = 0;

  const agencyOwnerBySeekerId = await getAgencyOwnersBySeekerId(
    candidates.map((c) => c.seekerId).filter(Boolean),
  );

  if (agencyOwnerBySeekerId.size > 0) {
    const namesByAgencyId = new Map();
    for (const candidate of candidates) {
      const agencyId = agencyOwnerBySeekerId.get(candidate.seekerId);
      if (!agencyId) continue;
      const names = namesByAgencyId.get(agencyId) || [];
      names.push(candidate.fullName || 'Unnamed candidate');
      namesByAgencyId.set(agencyId, names);
    }

    const agencyDocs = await Agency.find({ _id: { $in: [...namesByAgencyId.keys()] } })
      .select('userId agencyName');
    const agencyDocsById = new Map(agencyDocs.map((a) => [a._id.toString(), a]));

    const agencyUsers = await User.find({
      _id: { $in: agencyDocs.map((a) => a.userId.toString()) },
    }).select('email');
    const emailByAgencyUserId = new Map(agencyUsers.map((u) => [u._id.toString(), u.email]));

    await Promise.allSettled(
      [...namesByAgencyId.entries()].map(async ([agencyId, candidateNames]) => {
        const agencyDoc = agencyDocsById.get(agencyId);
        if (!agencyDoc) return;
        const agencyUserId = agencyDoc.userId.toString();

        await writeInAppNotification(
          agencyUserId,
          'roster_candidate_matched',
          candidateNames.length === 1 ? 'Your candidate matched a job' : 'Your candidates matched a job',
          `${candidateNames.join(', ')} from your roster matched "${jobTitle}".`,
          { jobId },
        );

        // The poster IS this agency: fold the callout into the single
        // poster email below instead of sending a second, near-duplicate
        // one to the same inbox for the same match event.
        if (agencyUserId === creatorId) {
          ownRosterNames = candidateNames;
          return;
        }

        const agencyEmail = emailByAgencyUserId.get(agencyUserId);
        if (!agencyEmail) return;

        try {
          const { subject, htmlBody } = buildRosterMatchEmail({
            jobTitle, posterName, candidateNames,
          });
          await sendEmail({ to: agencyEmail, subject, htmlBody });
          rosterAgenciesNotified += 1;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[notifications.service] job_id=${jobId} roster email failed for agency ${agencyId}:`, err.message);
        }
      }),
    );
  }

  let posterEmailSent = false;
  let posterEmailError = null;
  if (posterEmail) {
    try {
      const { subject, htmlBody } = buildPosterEmail({
        count: candidates.length, jobTitle, ownRosterNames,
      });
      await sendEmail({ to: posterEmail, subject, htmlBody });
      posterEmailSent = true;
    } catch (err) {
      posterEmailError = err.message;
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] job_id=${jobId} poster email failed:`, err.message);
    }
  } else {
    posterEmailError = 'Job poster has no email on file';
  }

  // eslint-disable-next-line no-console
  console.log(
    `[notifications.service] job_id=${jobId} sms_sent=${smsSent}/${candidates.length} `
    + `poster_email_sent=${posterEmailSent} roster_agencies_notified=${rosterAgenciesNotified}`,
  );

  return {
    smsAttempted: candidates.length,
    smsSent,
    smsFailed,
    posterEmailSent,
    posterEmailError,
    rosterAgenciesNotified,
  };
}

/**
 * Formats a Date for display in candidate-facing SMS/email — Ethiopia
 * is single-timezone (no DST to worry about), so a fixed IANA zone is
 * safe to hardcode rather than needing per-user timezone storage.
 *
 * @param {Date|string} date
 * @returns {string}
 */
function formatInterviewTime(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: 'Africa/Addis_Ababa',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

const INTERVIEW_MODE_LABELS = { in_person: 'in-person', phone: 'phone call', video: 'video call' };

/**
 * Builds the candidate-facing SMS body for an interview lifecycle
 * event. Kept short and link-free (SMS, not the full email) — enough
 * to convey what/when, with the location/link left to the email/app.
 *
 * @param {'scheduled'|'rescheduled'|'cancelled'} event
 * @param {{ jobTitle: string, posterName: string, when: string, mode: string }} params
 */
function buildInterviewSmsMessage(event, { jobTitle, posterName, when, mode }) {
  const modeLabel = INTERVIEW_MODE_LABELS[mode] || mode;
  if (event === 'cancelled') {
    return `Your ${modeLabel} interview for "${jobTitle}" with ${posterName} on ${when} has been cancelled.`;
  }
  if (event === 'rescheduled') {
    return `Your interview for "${jobTitle}" with ${posterName} has been rescheduled to ${when} (${modeLabel}).`;
  }
  return `Interview scheduled: "${jobTitle}" with ${posterName} on ${when} (${modeLabel}). Check your KeferaJobs app for details.`;
}

/**
 * Builds the candidate-facing email (subject + HTML body) for an
 * interview lifecycle event — carries the full detail (location/link,
 * notes) that the SMS deliberately leaves out.
 *
 * @param {'scheduled'|'rescheduled'|'cancelled'} event
 * @param {{
 *   jobTitle: string, posterName: string, when: string, mode: string,
 *   location: string|null, notes: string|null,
 * }} params
 */
function buildInterviewEmail(event, {
  jobTitle, posterName, when, mode, location, notes,
}) {
  const modeLabel = INTERVIEW_MODE_LABELS[mode] || mode;
  const verb = { scheduled: 'scheduled', rescheduled: 'rescheduled', cancelled: 'cancelled' }[event] || event;
  const subject = `Interview ${verb}: ${jobTitle}`;

  if (event === 'cancelled') {
    const htmlBody = `
      <p>Your ${modeLabel} interview for <strong>${jobTitle}</strong> with ${posterName}, `
      + `previously set for ${when}, has been cancelled.</p>
      <p>Log in to your KeferaJobs dashboard for more details.</p>
    `.trim();
    return { subject, htmlBody };
  }

  const htmlBody = `
    <p>Your interview for <strong>${jobTitle}</strong> with ${posterName} has been ${verb}.</p>
    <p><strong>When:</strong> ${when}<br/>
       <strong>Format:</strong> ${modeLabel}${location ? `<br/><strong>${mode === 'in_person' ? 'Location' : 'Link/number'}:</strong> ${location}` : ''}</p>
    ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ''}
    <p>Log in to your KeferaJobs dashboard for more details.</p>
  `.trim();
  return { subject, htmlBody };
}

/**
 * EMP-02: dispatches an SMS + email to the candidate for an interview
 * lifecycle event (scheduled / rescheduled / cancelled). Designed to
 * run as a background task (workers/notifications.worker.js), same
 * pattern as dispatchCandidateAlerts above — a failure on one channel
 * never blocks the other, and this function itself never throws for
 * "expected" delivery failures (no phone/email on file), only logs.
 *
 * @param {string} interviewId
 * @param {'scheduled'|'rescheduled'|'cancelled'} [event]
 * @returns {Promise<{ sent: boolean, smsSent: boolean, emailSent: boolean }>}
 */
async function notifyInterviewEvent(interviewId, event = 'scheduled') {
  const interview = await Interview.findById(interviewId);
  if (!interview) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] interview ${interviewId} not found for notification`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const [seeker, { jobTitle, posterName }] = await Promise.all([
    Seeker.findById(interview.seekerId).select('userId'),
    getJobAndPosterContact(interview.jobId.toString()),
  ]);
  if (!seeker) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] interview ${interviewId}: seeker ${interview.seekerId} not found`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const user = await User.findById(seeker.userId).select('phone email');
  const params = {
    jobTitle,
    posterName,
    when: formatInterviewTime(interview.scheduledFor),
    mode: interview.mode,
    location: interview.location,
    notes: interview.notes,
  };

  let smsSent = false;
  if (user?.phone) {
    try {
      await sendSMS({ to: user.phone, message: buildInterviewSmsMessage(event, params) });
      smsSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] interview_id=${interviewId} SMS failed:`, err.message);
    }
  }

  let emailSent = false;
  if (user?.email) {
    try {
      const { subject, htmlBody } = buildInterviewEmail(event, params);
      await sendEmail({ to: user.email, subject, htmlBody });
      emailSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] interview_id=${interviewId} email failed:`, err.message);
    }
  }

  const notificationType = {
    scheduled: 'interview_scheduled',
    rescheduled: 'interview_rescheduled',
    cancelled: 'interview_cancelled',
  }[event] || 'interview_scheduled';
  const notificationTitle = {
    scheduled: 'Interview scheduled',
    rescheduled: 'Interview rescheduled',
    cancelled: 'Interview cancelled',
  }[event] || 'Interview update';
  await writeInAppNotification(
    seeker.userId,
    notificationType,
    notificationTitle,
    buildInterviewSmsMessage(event, params),
    { placementId: interview.placementId.toString(), jobId: interview.jobId.toString() },
  );

  return { sent: smsSent || emailSent, smsSent, emailSent };
}

/**
 * EMP-02: notifies whichever placement participant did NOT send a
 * given message that a new message is waiting. Deliberately never
 * includes the message body in the SMS/email — just a "log in to
 * view/reply" nudge, both for SMS length and so message content isn't
 * duplicated into a less secure channel.
 *
 * @param {string} messageId
 * @returns {Promise<{ sent: boolean, smsSent: boolean, emailSent: boolean }>}
 */
async function notifyNewMessage(messageId) {
  const message = await Message.findById(messageId);
  if (!message) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] message ${messageId} not found for notification`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const placement = await Placement.findById(message.placementId).select('jobId seekerId');
  if (!placement) {
    return { sent: false, smsSent: false, emailSent: false };
  }

  const [job, seeker] = await Promise.all([
    Job.findById(placement.jobId).select('creatorId title'),
    Seeker.findById(placement.seekerId).select('userId'),
  ]);
  if (!job || !seeker) {
    return { sent: false, smsSent: false, emailSent: false };
  }

  // Recipient is whichever participant did NOT send this message.
  const recipientUserId = message.senderRole === 'seeker'
    ? job.creatorId.toString()
    : seeker.userId.toString();

  const user = await User.findById(recipientUserId).select('phone email');
  const smsMessage = `New message about "${job.title}" on KeferaJobs. Log in to view and reply.`;

  let smsSent = false;
  if (user?.phone) {
    try {
      await sendSMS({ to: user.phone, message: smsMessage });
      smsSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] message_id=${messageId} SMS failed:`, err.message);
    }
  }

  let emailSent = false;
  if (user?.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: `New message about "${job.title}"`,
        htmlBody: `
          <p>You have a new message regarding <strong>${job.title}</strong>.</p>
          <p>Log in to your KeferaJobs dashboard to view and reply.</p>
        `.trim(),
      });
      emailSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] message_id=${messageId} email failed:`, err.message);
    }
  }

  // Unlike the SMS/email body above, this deliberately DOES include a
  // preview of the message text — the in-app feed is inside the same
  // authenticated surface the thread itself lives behind, not a less
  // secure external channel, so there's no reason to withhold it here.
  await writeInAppNotification(
    recipientUserId,
    'new_message',
    `New message about "${job.title}"`,
    message.body.length > 140 ? `${message.body.slice(0, 140)}…` : message.body,
    { placementId: message.placementId.toString() },
  );

  return { sent: smsSent || emailSent, smsSent, emailSent };
}

/**
 * JS-05: notifies a job's poster (employer/agency) that a seeker
 * applied directly, via SMS + email — same "look up the participant,
 * try each channel independently, never let one channel's failure
 * block the other" shape as notifyNewMessage above.
 *
 * @param {string} applicationId
 * @returns {Promise<{ sent: boolean, smsSent: boolean, emailSent: boolean }>}
 */
async function notifyNewApplication(applicationId) {
  const application = await Application.findById(applicationId);
  if (!application) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] application ${applicationId} not found for notification`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const [job, seeker] = await Promise.all([
    Job.findById(application.jobId).select('creatorId title'),
    Seeker.findById(application.seekerId).select('fullName'),
  ]);
  if (!job) {
    return { sent: false, smsSent: false, emailSent: false };
  }

  const applicantName = seeker?.fullName || 'A seeker';
  const user = await User.findById(job.creatorId).select('phone email');
  const smsMessage = `${applicantName} applied for "${job.title}" on KeferaJobs. Log in to view their profile.`;

  let smsSent = false;
  if (user?.phone) {
    try {
      await sendSMS({ to: user.phone, message: smsMessage });
      smsSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] application_id=${applicationId} SMS failed:`, err.message);
    }
  }

  let emailSent = false;
  if (user?.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: `New application for "${job.title}"`,
        htmlBody: `
          <p><strong>${applicantName}</strong> just applied for <strong>${job.title}</strong>.</p>
          <p>Log in to your KeferaJobs dashboard to view their profile.</p>
        `.trim(),
      });
      emailSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] application_id=${applicationId} email failed:`, err.message);
    }
  }

  await writeInAppNotification(
    job.creatorId,
    'new_application',
    'New application',
    `${applicantName} applied for "${job.title}".`,
    { applicationId, jobId: application.jobId.toString() },
  );

  return { sent: smsSent || emailSent, smsSent, emailSent };
}

/**
 * Builds the rejection SMS body. A separate function (rather than
 * inlined into notifyVerificationRejected below) so admin.service.js's
 * tests, or a future email-preview screen, can render the same copy
 * without going through the SMS provider — same convention as
 * `buildCandidateSmsMessage`/`buildInterviewSmsMessage` elsewhere in
 * this file.
 *
 * @param {string} reason - the admin's rejection reason
 * @param {{ status: string, amount?: number, currency?: string }} refund
 */
function buildVerificationRejectedSmsMessage(reason, refund) {
  const base = `Your KeferaJobs verification was not approved: ${reason}`;

  if (refund?.status === 'refunded') {
    const amountText = refund.amount != null
      ? ` of ${refund.amount} ${refund.currency || 'ETB'}`
      : '';
    return `${base} Your subscription payment${amountText} has been refunded. `
      + 'You may update your documents and resubmit for review at any time.';
  }

  if (refund?.status === 'refund_failed') {
    return `${base} We were unable to process your refund automatically — `
      + 'our team will contact you about it shortly. '
      + 'You may update your documents and resubmit for review at any time.';
  }

  // 'none' (no verified subscription payment on file) or refund wasn't
  // attempted for some other reason — nothing to say about money.
  return `${base} You may update your documents and resubmit for review at any time.`;
}

/**
 * Handles a NOTIFY_VERIFICATION_REJECTED task (see
 * admin.service.js#rejectUser, which enqueues this): SMS's + emails the
 * rejected employer/agency with the rejection reason and, if
 * applicable, the outcome of the automatic subscription refund.
 *
 * `refund` is a snapshot passed in by the caller
 * (admin.service.js#refundLatestSubscriptionPayment already ran before
 * this was enqueued) rather than recomputed here — see the doc comment
 * on `enqueueVerificationRejectedNotification`.
 *
 * @param {string} userId
 * @param {string} reason
 * @param {{ status: string, amount?: number, currency?: string }} [refund]
 * @returns {Promise<{ sent: boolean, smsSent: boolean, emailSent: boolean }>}
 */
async function notifyVerificationRejected(userId, reason, refund = { status: 'none' }) {
  const user = await User.findById(userId).select('phone email role');
  if (!user) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] user ${userId} not found for verification-rejected notification`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const ProfileModel = user.role === 'employer' ? Employer : Agency;
  const profile = await ProfileModel.findOne({ userId }).select('companyName agencyName');
  const accountName = profile?.companyName || profile?.agencyName || 'Your account';

  const smsMessage = buildVerificationRejectedSmsMessage(reason, refund);

  let smsSent = false;
  if (user.phone) {
    try {
      await sendSMS({ to: user.phone, message: smsMessage });
      smsSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] user_id=${userId} verification-rejected SMS failed:`, err.message);
    }
  }

  let emailSent = false;
  if (user.email) {
    try {
      const refundLine = refund?.status === 'refunded'
        ? `<p>Your subscription payment${refund.amount != null ? ` of ${refund.amount} ${refund.currency || 'ETB'}` : ''} has been refunded.</p>`
        : refund?.status === 'refund_failed'
          ? '<p>We were unable to process your refund automatically — our team will contact you about it shortly.</p>'
          : '';
      await sendEmail({
        to: user.email,
        subject: 'Your KeferaJobs verification was not approved',
        htmlBody: `
          <p>Hi ${accountName},</p>
          <p>Your account verification was not approved for the following reason:</p>
          <p><strong>${reason}</strong></p>
          ${refundLine}
          <p>You may update your documents and resubmit for review at any time.</p>
        `.trim(),
      });
      emailSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] user_id=${userId} verification-rejected email failed:`, err.message);
    }
  }

  await writeInAppNotification(
    userId,
    'verification_rejected',
    'Verification not approved',
    smsMessage,
    { reason, refundStatus: refund?.status || 'none' },
  );

  return { sent: smsSent || emailSent, smsSent, emailSent };
}

/**
 * Handles a NOTIFY_ACCOUNT_STATUS_CHANGED task (see
 * admin.service.js#setAccountStatus, which enqueues this): SMS's +
 * emails an employer/agency when admin suspends or reactivates their
 * account outside the verification flow — see the doc comment on
 * User.model.js's `accountStatus` field for how this differs from
 * verification rejection.
 *
 * @param {string} userId
 * @param {'active'|'suspended'} status
 * @param {string|null} [reason]
 * @returns {Promise<{ sent: boolean, smsSent: boolean, emailSent: boolean }>}
 */
async function notifyAccountStatusChanged(userId, status, reason) {
  const user = await User.findById(userId).select('phone email role');
  if (!user) {
    // eslint-disable-next-line no-console
    console.error(`[notifications.service] user ${userId} not found for account-status-changed notification`);
    return { sent: false, smsSent: false, emailSent: false };
  }

  const ProfileModel = user.role === 'employer' ? Employer : Agency;
  const profile = await ProfileModel.findOne({ userId }).select('companyName agencyName');
  const accountName = profile?.companyName || profile?.agencyName || 'Your account';

  const smsMessage = status === 'suspended'
    ? `Your KeferaJobs account has been suspended by an administrator.${reason ? ` Reason: ${reason}.` : ''} Contact support if you believe this is a mistake.`
    : 'Your KeferaJobs account has been reactivated. You can resume using the platform normally.';

  let smsSent = false;
  if (user.phone) {
    try {
      await sendSMS({ to: user.phone, message: smsMessage });
      smsSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] user_id=${userId} account-status-changed SMS failed:`, err.message);
    }
  }

  let emailSent = false;
  if (user.email) {
    try {
      await sendEmail({
        to: user.email,
        subject: status === 'suspended'
          ? 'Your KeferaJobs account has been suspended'
          : 'Your KeferaJobs account has been reactivated',
        htmlBody: `
          <p>Hi ${accountName},</p>
          <p>${smsMessage}</p>
        `.trim(),
      });
      emailSent = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[notifications.service] user_id=${userId} account-status-changed email failed:`, err.message);
    }
  }

  await writeInAppNotification(
    userId,
    'account_status_changed',
    status === 'suspended' ? 'Account suspended' : 'Account reactivated',
    smsMessage,
    { status, reason: reason || null },
  );

  return { sent: smsSent || emailSent, smsSent, emailSent };
}

module.exports = {
  dispatchCandidateAlerts,
  buildCandidateSmsMessage,
  buildPosterEmail,
  getJobAndPosterContact,
  notifyInterviewEvent,
  buildInterviewSmsMessage,
  buildInterviewEmail,
  notifyNewMessage,
  notifyNewApplication,
  notifyVerificationRejected,
  buildVerificationRejectedSmsMessage,
  notifyAccountStatusChanged,
};
