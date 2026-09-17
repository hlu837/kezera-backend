process.env.JWT_SECRET = 'x';
process.env.AWS_REGION = 'x';
process.env.AWS_S3_BUCKET = 'x';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';
process.env.REDIS_URL = 'redis://localhost:6379'; // won't be used since we bypass queue

process.chdir('/home/claude/kezera/kezerajobs-master/backend');

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

async function main() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(process.env.MONGODB_URI);

  const { User, Seeker, Employer, Job, Placement } = require('./src/models');

  // Stub out notification enqueue so we don't need Redis for this test.
  const notifQueue = require('./src/queues/notifications.queue');
  notifQueue.enqueueInterviewNotification = async () => { console.log('  [stub] enqueueInterviewNotification called'); };
  notifQueue.enqueueNewMessageNotification = async () => { console.log('  [stub] enqueueNewMessageNotification called'); };

  const interviewsService = require('./src/services/interviews.service');
  const messagingService = require('./src/services/messaging.service');
  const seekerService = require('./src/services/seeker.service');

  // --- Set up an employer, a seeker, a job, and a placement ---
  const employerUser = await User.create({ phone: '+251911000001', email: 'emp@example.com', passwordHash: 'x', role: 'employer' });
  const employer = await Employer.create({ userId: employerUser._id, companyName: 'ABC Retail' });

  const seekerUser = await User.create({ phone: '+251911000002', email: 'seeker@example.com', passwordHash: 'x', role: 'seeker' });
  const seeker = await Seeker.create({ userId: seekerUser._id, fullName: 'Abebe Kebede', skills: ['sales'] });

  const job = await Job.create({
    creatorId: employerUser._id, creatorType: 'employer', title: 'Sales Associate',
    description: 'Retail sales role', location: 'Addis Ababa', jobType: 'Full-Time', skillsRequired: ['sales'],
  });

  const placement = await Placement.create({ jobId: job._id, seekerId: seeker._id, status: 'sent', score: 0.8 });

  console.log('=== Test 1: seeker discovers own placements ===');
  const myPlacements = await seekerService.getMyPlacements(seekerUser._id.toString());
  console.log(JSON.stringify(myPlacements, null, 2));
  if (myPlacements.length !== 1 || myPlacements[0].jobTitle !== 'Sales Associate') throw new Error('FAIL: getMyPlacements');
  console.log('PASS');

  console.log('=== Test 2: employer schedules an interview ===');
  const interview = await interviewsService.scheduleInterview(
    employerUser._id.toString(), 'employer', placement._id.toString(),
    { scheduled_for: new Date(Date.now() + 86400000).toISOString(), mode: 'video', location: 'https://meet.example.com/x', notes: 'Bring ID' },
  );
  console.log(JSON.stringify(interview, null, 2));
  if (interview.status !== 'scheduled') throw new Error('FAIL: interview status');
  console.log('PASS');

  console.log('=== Test 3: placement auto-advanced sent -> interviewed ===');
  const updatedPlacement = await Placement.findById(placement._id);
  console.log('placement.status =', updatedPlacement.status);
  if (updatedPlacement.status !== 'interviewed') throw new Error('FAIL: placement not auto-advanced');
  console.log('PASS');

  console.log('=== Test 4: seeker CANNOT schedule an interview (poster-only) ===');
  try {
    await interviewsService.scheduleInterview(seekerUser._id.toString(), 'seeker', placement._id.toString(), { scheduled_for: new Date(Date.now() + 86400000).toISOString(), mode: 'phone' });
    throw new Error('FAIL: seeker was allowed to schedule');
  } catch (err) {
    if (err.statusCode !== 403) throw err;
    console.log('PASS (403 as expected):', err.message);
  }

  console.log('=== Test 5: random other user CANNOT access the placement ===');
  const strangerUser = await User.create({ phone: '+251911000003', email: 'stranger@example.com', passwordHash: 'x', role: 'employer' });
  try {
    await interviewsService.listInterviewsForPlacement(strangerUser._id.toString(), 'employer', placement._id.toString());
    throw new Error('FAIL: stranger was allowed to view');
  } catch (err) {
    if (err.statusCode !== 404) throw err;
    console.log('PASS (404 as expected):', err.message);
  }

  console.log('=== Test 6: reschedule interview ===');
  const rescheduled = await interviewsService.rescheduleInterview(
    employerUser._id.toString(), 'employer', interview.id, { scheduled_for: new Date(Date.now() + 2 * 86400000).toISOString() },
  );
  console.log('new scheduledFor =', rescheduled.scheduledFor);
  console.log('PASS');

  console.log('=== Test 7: messaging both directions ===');
  const msg1 = await messagingService.sendMessage(employerUser._id.toString(), 'employer', placement._id.toString(), 'Hi Abebe, looking forward to the interview!');
  console.log('senderRole for employer message:', msg1.senderRole);
  if (msg1.senderRole !== 'employer') throw new Error('FAIL: senderRole wrong');

  const msg2 = await messagingService.sendMessage(seekerUser._id.toString(), 'seeker', placement._id.toString(), 'Thank you, see you then!');
  console.log('senderRole for seeker message:', msg2.senderRole);
  if (msg2.senderRole !== 'seeker') throw new Error('FAIL: senderRole wrong');

  console.log('=== Test 8: listMessages marks unread as read ===');
  const threadForEmployer = await messagingService.listMessages(employerUser._id.toString(), 'employer', placement._id.toString());
  console.log(JSON.stringify(threadForEmployer.map(m => ({ sender: m.senderRole, body: m.body, readAt: m.readAt })), null, 2));
  const employerMsgInDb = await require('./src/models').Message.findById(msg1.id);
  console.log('employer own message readAt (should still be null, sender does not mark own msg read):', employerMsgInDb.readAt);
  const seekerMsgInDb = await require('./src/models').Message.findById(msg2.id);
  console.log('seeker message readAt AFTER employer listed thread (should be set now):', seekerMsgInDb.readAt);
  if (!seekerMsgInDb.readAt) throw new Error('FAIL: message not marked read');
  console.log('PASS');

  console.log('=== Test 9: cancel interview ===');
  const cancelled = await interviewsService.updateInterviewStatus(employerUser._id.toString(), 'employer', interview.id, 'cancelled');
  console.log('interview status =', cancelled.status);
  if (cancelled.status !== 'cancelled') throw new Error('FAIL');
  console.log('PASS');

  console.log('=== Test 10: cannot reschedule a cancelled interview ===');
  try {
    await interviewsService.rescheduleInterview(employerUser._id.toString(), 'employer', interview.id, { mode: 'phone' });
    throw new Error('FAIL: rescheduled a cancelled interview');
  } catch (err) {
    if (err.statusCode !== 409) throw err;
    console.log('PASS (409 as expected):', err.message);
  }

  console.log('\nALL TESTS PASSED');
  await mongoose.disconnect();
  await mongod.stop();
  process.exit(0);
}

main().catch((err) => { console.error('TEST SUITE FAILED:', err); process.exit(1); });
