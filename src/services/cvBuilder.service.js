'use strict';

const PDFDocument = require('pdfkit');
const { Seeker } = require('../models');
const AppError = require('../errors/AppError');
const storageService = require('./storage.service');

// Wire format (request body / Joi-validated, snake_case) -> Mongoose
// subdocument field name (camelCase). Same mapping pattern as
// seeker.service.js's UPDATABLE_FIELD_MAP.
function mapExperience(items) {
  return (items || []).map((e) => ({
    title: e.title,
    company: e.company,
    location: e.location || null,
    startDate: e.start_date || null,
    endDate: e.current ? null : e.end_date || null,
    current: Boolean(e.current),
    description: e.description || null,
  }));
}

function mapEducation(items) {
  return (items || []).map((e) => ({
    school: e.school,
    degree: e.degree,
    fieldOfStudy: e.field_of_study || null,
    startDate: e.start_date || null,
    endDate: e.current ? null : e.end_date || null,
    current: Boolean(e.current),
    gpa: e.gpa === '' || e.gpa === undefined ? null : e.gpa,
  }));
}

function mapLanguages(items) {
  return (items || []).map((l) => ({ name: l.name, level: l.level }));
}

/**
 * PATCH /api/v1/seekers/me/cv-builder
 * Saves whichever of experience/education/languages/template are
 * present, WITHOUT touching the ones that aren't — same partial-update
 * contract as seeker.service.js#updateMyProfile — so "Save & exit"
 * partway through the wizard never clobbers a section the seeker
 * hasn't reached yet.
 *
 * @param {string} userId
 * @param {{ experience?: object[], education?: object[], languages?: object[], template?: string }} updates - already Joi-validated
 */
async function saveCvBuilderData(userId, updates) {
  const setDoc = {};
  if (updates.experience !== undefined) setDoc.experience = mapExperience(updates.experience);
  if (updates.education !== undefined) setDoc.education = mapEducation(updates.education);
  if (updates.languages !== undefined) setDoc.languages = mapLanguages(updates.languages);
  if (updates.template !== undefined) setDoc.cvTemplate = updates.template;

  const profile = await Seeker.findOneAndUpdate(
    { userId },
    { $set: setDoc },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Seeker profile not found', 404);
  }
  return profile.toJSON();
}

// --- PDF rendering -------------------------------------------------------

const TEMPLATE_THEMES = {
  classic: { accent: '#1F2937', font: 'Times-Roman', boldFont: 'Times-Bold', headingCase: 'upper' },
  modern: { accent: '#15803D', font: 'Helvetica', boldFont: 'Helvetica-Bold', headingCase: 'upper' },
  minimal: { accent: '#111111', font: 'Helvetica', boldFont: 'Helvetica-Bold', headingCase: 'title' },
};

function formatDateRange(startDate, endDate, current) {
  const start = startDate || '';
  const end = current ? 'Present' : endDate || '';
  if (!start && !end) return '';
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

function drawSectionHeading(doc, theme, text) {
  const label = theme.headingCase === 'upper' ? text.toUpperCase() : text;
  doc.moveDown(0.8);
  doc.font(theme.boldFont).fontSize(12).fillColor(theme.accent).text(label);
  doc
    .moveTo(doc.x, doc.y + 2)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y + 2)
    .strokeColor(theme.accent)
    .lineWidth(0.75)
    .stroke();
  doc.moveDown(0.5);
  doc.fillColor('#000000');
}

/**
 * Renders a seeker's CV builder data into a PDF buffer using one of the
 * 3 templates (`classic` | `modern` | `minimal`). The templates differ
 * only in typography/accent color, not layout — a proper multi-column
 * or graphical layout per template is a nice-to-have, not needed for a
 * first working version.
 *
 * @param {{
 *   fullName: string, city?: string|null, bio?: string|null,
 *   experience: object[], education: object[], languages: object[],
 *   template: 'classic'|'modern'|'minimal',
 * }} data
 * @returns {Promise<Buffer>}
 */
function renderCvPdf(data) {
  const theme = TEMPLATE_THEMES[data.template] || TEMPLATE_THEMES.classic;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc.font(theme.boldFont).fontSize(22).fillColor(theme.accent).text(data.fullName || 'Untitled CV');
    doc.fillColor('#000000');
    const subtitleParts = [data.city].filter(Boolean);
    if (subtitleParts.length > 0) {
      doc.font(theme.font).fontSize(10).fillColor('#555555').text(subtitleParts.join(' · '));
    }
    doc.fillColor('#000000');

    if (data.bio) {
      drawSectionHeading(doc, theme, 'Summary');
      doc.font(theme.font).fontSize(10.5).text(data.bio, { align: 'left' });
    }

    if (data.experience && data.experience.length > 0) {
      drawSectionHeading(doc, theme, 'Experience');
      data.experience.forEach((item, i) => {
        doc.font(theme.boldFont).fontSize(11).text(`${item.title} · ${item.company}`);
        const range = formatDateRange(item.startDate, item.endDate, item.current);
        const meta = [item.location, range].filter(Boolean).join('  |  ');
        if (meta) {
          doc.font(theme.font).fontSize(9.5).fillColor('#555555').text(meta);
          doc.fillColor('#000000');
        }
        if (item.description) {
          doc.font(theme.font).fontSize(10).text(item.description);
        }
        if (i < data.experience.length - 1) doc.moveDown(0.5);
      });
    }

    if (data.education && data.education.length > 0) {
      drawSectionHeading(doc, theme, 'Education');
      data.education.forEach((item, i) => {
        const degreeLine = item.fieldOfStudy ? `${item.degree}, ${item.fieldOfStudy}` : item.degree;
        const schoolLine = item.gpa != null ? `${item.school} · GPA ${item.gpa.toFixed(2)}` : item.school;
        doc.font(theme.boldFont).fontSize(11).text(`${degreeLine} · ${schoolLine}`);
        const range = formatDateRange(item.startDate, item.endDate, item.current);
        if (range) {
          doc.font(theme.font).fontSize(9.5).fillColor('#555555').text(range);
          doc.fillColor('#000000');
        }
        if (i < data.education.length - 1) doc.moveDown(0.5);
      });
    }

    if (data.languages && data.languages.length > 0) {
      drawSectionHeading(doc, theme, 'Languages');
      const line = data.languages.map((l) => `${l.name} (${l.level})`).join('   ·   ');
      doc.font(theme.font).fontSize(10.5).text(line);
    }

    doc.end();
  });
}

/**
 * POST /api/v1/seekers/me/cv-builder/generate
 * CV-03: saves the full builder payload, renders it into a PDF with the
 * chosen template, uploads it to storage, and stores the resulting URL
 * as this seeker's `cvUrl` — same field a plain file upload sets, so
 * the rest of the app doesn't need to know a CV was builder-generated
 * rather than uploaded (see seeker_profile_repository.dart's doc
 * comment on `generateCv`).
 *
 * @param {string} userId
 * @param {{ template: string, experience: object[], education: object[], languages: object[] }} payload - already Joi-validated
 */
async function generateCv(userId, payload) {
  const experience = mapExperience(payload.experience);
  const education = mapEducation(payload.education);
  const languages = mapLanguages(payload.languages);

  // Fetch fullName/city/bio up front — the CV builder wizard doesn't
  // resend personal details on generate (those are saved separately via
  // the regular PATCH /seekers/me), so the PDF is rendered from
  // whatever's already on the profile.
  const existingProfile = await Seeker.findOne({ userId });
  if (!existingProfile) {
    throw new AppError('Seeker profile not found', 404);
  }

  const pdfBuffer = await renderCvPdf({
    fullName: existingProfile.fullName,
    city: existingProfile.city,
    bio: existingProfile.bio,
    experience,
    education,
    languages,
    template: payload.template,
  });

  const key = `seekers/${userId}/cv/cv-builder-${Date.now()}.pdf`;
  const cvUrl = await storageService.uploadBuffer(pdfBuffer, key, 'application/pdf');

  const profile = await Seeker.findOneAndUpdate(
    { userId },
    {
      $set: {
        experience,
        education,
        languages,
        cvTemplate: payload.template,
        cvUrl,
      },
    },
    { new: true, runValidators: true },
  );

  return profile.toJSON();
}

module.exports = { saveCvBuilderData, generateCv };
