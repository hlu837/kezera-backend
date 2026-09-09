'use strict';

/**
 * Flat list of skill keywords/phrases the CV parser scans for.
 *
 * Deliberately broad — KeferaJobs spans both office/professional roles
 * and blue-collar/daily-labor roles (see Job.model.js's `jobType` enum,
 * which includes 'Daily'), so this mixes trade skills, service skills,
 * and tech skills rather than assuming one job market segment.
 *
 * Matching is word-boundary + case-insensitive (see cvParser.service.js
 * #extractSkills), so multi-word entries like "customer service" match
 * as a phrase. This list is intentionally a plain array, not an enum
 * enforced anywhere else — Seeker.skills stays free-text (matches the
 * existing model), this just seeds it from CV content.
 *
 * Extend by adding entries; no other code needs to change.
 */
const SKILLS_TAXONOMY = [
  // Trades / manual
  'plumbing', 'welding', 'carpentry', 'electrician', 'electrical wiring',
  'masonry', 'painting', 'tiling', 'construction', 'machine operation',
  'forklift operation', 'auto mechanics', 'vehicle maintenance', 'driving',
  'heavy truck driving', 'motorcycle riding', 'delivery', 'warehouse',
  'logistics', 'inventory management', 'packaging', 'tailoring',
  'sewing', 'hairdressing', 'barbering', 'cleaning', 'housekeeping',
  'gardening', 'landscaping', 'security', 'cctv monitoring',

  // Hospitality / food
  'cooking', 'baking', 'catering', 'food preparation', 'barista',
  'waitering', 'bartending', 'hotel management', 'housekeeping supervision',

  // Office / admin
  'data entry', 'receptionist', 'office administration', 'filing',
  'scheduling', 'record keeping', 'typing', 'transcription',
  'customer service', 'call center', 'telemarketing', 'cashier',
  'inventory control', 'stock taking', 'procurement', 'supply chain',

  // Sales / marketing
  'sales', 'retail sales', 'business development', 'marketing',
  'digital marketing', 'social media marketing', 'seo', 'branding',
  'market research', 'negotiation', 'merchandising',

  // Finance / accounting
  'accounting', 'bookkeeping', 'auditing', 'financial analysis',
  'tax preparation', 'budgeting', 'payroll', 'cash handling',
  'quickbooks', 'peachtree', 'financial reporting',

  // Healthcare
  'nursing', 'first aid', 'patient care', 'pharmacy', 'phlebotomy',
  'midwifery', 'medical records', 'clinical assessment',

  // Education
  'teaching', 'tutoring', 'curriculum development', 'lesson planning',
  'classroom management', 'training and development',

  // Management / soft skills
  'project management', 'team leadership', 'people management',
  'communication', 'problem solving', 'time management',
  'conflict resolution', 'critical thinking', 'public speaking',
  'report writing', 'strategic planning', 'event planning',

  // Languages
  'amharic', 'english', 'oromo', 'tigrinya', 'somali', 'arabic',
  'french', 'french language',

  // Tech / office software
  'microsoft excel', 'microsoft word', 'microsoft powerpoint',
  'microsoft office', 'google sheets', 'graphic design', 'photoshop',
  'illustrator', 'autocad', 'video editing',

  // Software engineering
  'javascript', 'typescript', 'python', 'java', 'php', 'sql',
  'html', 'css', 'react', 'react native', 'node.js', 'express',
  'flutter', 'dart', 'mongodb', 'postgresql', 'mysql', 'firebase',
  'git', 'rest api', 'android development', 'ios development',
  'devops', 'linux', 'network administration', 'cybersecurity',
  'ui/ux design', 'wordpress',
];

module.exports = { SKILLS_TAXONOMY };
