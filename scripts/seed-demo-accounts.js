'use strict';

require('dotenv').config({ override: true });

const bcrypt = require('bcrypt');
const { mongoose, connectMongo } = require('../src/config/mongoose');
const { User, Employer, Agency } = require('../src/models');

const DEMO_ACCOUNTS = [
  {
    email: 'employer.demo@example.com',
    password: 'KeferaEmployer2026!',
    role: 'employer',
    companyName: 'Kefera Demo Employer',
    backofficePhone: '+251911000001',
    tinNumber: 'EMP-2026-001',
    subscriptionTier: 'basic',
  },
  {
    email: 'agency.demo@example.com',
    password: 'KeferaAgency2026!',
    role: 'agency',
    agencyName: 'Kefera Demo Agency',
    operationalCity: 'Addis Ababa',
    tinNumber: 'AGY-2026-001',
    subscriptionTier: 'basic',
  },
];

async function ensureDemoAccount(account) {
  const existing = await User.findOne({ email: account.email.toLowerCase() }).select('+passwordHash');
  if (existing) {
    const passwordMatches = await bcrypt.compare(account.password, existing.passwordHash);
    if (passwordMatches && existing.verificationStatus !== 'approved') {
      existing.verificationStatus = 'approved';
      await existing.save();
      console.log(`[demo] approved existing ${account.role}: ${account.email}`);
    } else if (!passwordMatches) {
      existing.passwordHash = await bcrypt.hash(account.password, 12);
      existing.verificationStatus = 'approved';
      await existing.save();
      console.log(`[demo] reset password and approved ${account.role}: ${account.email}`);
    } else {
      console.log(`[demo] already valid ${account.role}: ${account.email}`);
    }
    return existing;
  }

  const passwordHash = await bcrypt.hash(account.password, 12);
  const user = await User.create({
    email: account.email.toLowerCase(),
    passwordHash,
    role: account.role,
    verificationStatus: 'approved',
  });

  if (account.role === 'employer') {
    await Employer.create({
      userId: user._id,
      companyName: account.companyName,
      backofficePhone: account.backofficePhone,
      tinNumber: account.tinNumber,
      subscriptionTier: account.subscriptionTier,
    });
  } else {
    await Agency.create({
      userId: user._id,
      agencyName: account.agencyName,
      operationalCity: account.operationalCity,
      tinNumber: account.tinNumber,
      subscriptionTier: account.subscriptionTier,
    });
  }

  console.log(`[demo] created approved ${account.role}: ${account.email}`);
  return user;
}

async function main() {
  await connectMongo();

  for (const account of DEMO_ACCOUNTS) {
    await ensureDemoAccount(account);
  }

  console.log('\nDemo accounts ready.');
  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('Failed to seed demo accounts:', err);
  process.exit(1);
});
