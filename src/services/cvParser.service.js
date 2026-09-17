'use strict';

const pdfParse = require('pdf-parse');
const { SKILLS_TAXONOMY } = require('../utils/skills.taxonomy');
const { CITIES_TAXONOMY } = require('../utils/cities.taxonomy');

/**
 * Only PDFs are parsed for now (see upload flow decision — DOCX CVs
 * are still accepted for storage per FILE_RULES.cv in file.util.js,
 * they just don't get auto-fill; a DOCX parser can be added later
 * behind the same `parseCv` entry point without touching callers).
 */
const PARSEABLE_MIME_TYPES = ['application/pdf'];

/** Section headings that mark the end of a "summary/objective" block. */
const STOP_HEADINGS = [
  'experience', 'work experience', 'employment history', 'education',
  'skills', 'certifications', 'projects', 'references', 'languages',
  'contact', 'training', 'qualifications', 'achievements',
];

/** Section headings that mark the start of a summary/objective block. */
const SUMMARY_HEADINGS = ['summary', 'objective', 'profile', 'about me', 'career objective', 'professional summary'];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts raw text from a CV file buffer. Returns null for file types
 * we don't parse (or if extraction fails) — callers must treat that as
 * "no auto-fill available", not an error; a CV that can't be parsed
 * should still upload successfully.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<string|null>}
 */
async function extractText(buffer, mimetype) {
  if (!PARSEABLE_MIME_TYPES.includes(mimetype)) {
    return null;
  }
  try {
    const { text } = await pdfParse(buffer);
    return (text || '').trim() || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[cvParser.service] PDF text extraction failed', err);
    return null;
  }
}

/**
 * Scans text for every taxonomy skill that appears as a whole word/phrase
 * (case-insensitive). Order of the returned array follows first
 * appearance in the text, not taxonomy order.
 *
 * @param {string} text
 * @returns {string[]} matched skills, as written in SKILLS_TAXONOMY
 */
function extractSkills(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];

  for (const skill of SKILLS_TAXONOMY) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(skill.toLowerCase())}(?:$|[^a-z0-9])`, 'i');
    if (pattern.test(lower)) {
      found.push(skill);
    }
  }
  return found;
}

/**
 * Picks the most likely current city from CV text: the taxonomy entry
 * that appears earliest in the document (CVs typically list the
 * candidate's own address/location near the top, above job history
 * where other cities might be mentioned as past work locations).
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractCity(text) {
  if (!text) return null;

  let bestMatch = null;
  let bestIndex = Infinity;

  for (const city of CITIES_TAXONOMY) {
    const pattern = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(city.toLowerCase())}(?:$|[^a-z0-9])`, 'i');
    const match = pattern.exec(text.toLowerCase());
    if (match && match.index < bestIndex) {
      bestIndex = match.index;
      bestMatch = city;
    }
  }
  return bestMatch;
}

/**
 * Pulls a short bio out of a CV: prefers the content under an explicit
 * "Summary"/"Objective"/"Profile" heading; falls back to the first
 * substantial paragraph (skips short lines like name/contact details).
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractBio(text) {
  if (!text) return null;

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const headingPattern = new RegExp(`^(${SUMMARY_HEADINGS.join('|')})\\s*:?\\s*$`, 'i');
  const stopPattern = new RegExp(`^(${STOP_HEADINGS.join('|')})\\s*:?\\s*$`, 'i');

  const headingIndex = lines.findIndex((l) => headingPattern.test(l));
  if (headingIndex !== -1) {
    const collected = [];
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      if (!lines[i]) {
        if (collected.length > 0) break; // blank line after content ends the section
        continue; // blank line before any content — keep looking
      }
      if (stopPattern.test(lines[i])) break;
      collected.push(lines[i]);
    }
    const bio = collected.join(' ').trim();
    if (bio.length >= 30) {
      return bio.slice(0, 800);
    }
  }

  // Fallback: first paragraph-like run of text that reads like prose
  // rather than a contact/header line (has several words, not all-caps
  // like a section title, no @ or phone-number pattern).
  const paragraphs = text.split(/\r?\n\s*\r?\n/).map((p) => p.replace(/\s+/g, ' ').trim());
  for (const para of paragraphs) {
    const wordCount = para.split(/\s+/).filter(Boolean).length;
    const looksLikeContactInfo = /@|https?:\/\/|\+?\d{6,}/.test(para);
    const isAllCapsHeading = para === para.toUpperCase() && wordCount <= 5;
    if (wordCount >= 8 && para.length >= 40 && !looksLikeContactInfo && !isAllCapsHeading) {
      return para.slice(0, 800);
    }
  }
  return null;
}

/**
 * Full pipeline: buffer -> { text, skills, city, bio }. Never throws —
 * a parsing failure just means every field comes back null/empty, so
 * the CV upload itself always succeeds regardless of parse outcome.
 *
 * @param {Buffer} buffer
 * @param {string} mimetype
 * @returns {Promise<{ text: string|null, skills: string[], city: string|null, bio: string|null }>}
 */
async function parseCv(buffer, mimetype) {
  const text = await extractText(buffer, mimetype);
  if (!text) {
    return { text: null, skills: [], city: null, bio: null };
  }
  return {
    text,
    skills: extractSkills(text),
    city: extractCity(text),
    bio: extractBio(text),
  };
}

module.exports = { parseCv, extractText, extractSkills, extractCity, extractBio };
