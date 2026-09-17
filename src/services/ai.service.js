'use strict';

const fetch = require('node-fetch');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-4-6';

/**
 * Employer/agency-facing applicant summaries (applicationSummary.service.js)
 * is the only current caller of this module. Kept as its own thin
 * wrapper — rather than folding the fetch call directly into that
 * service — so a future feature needing an AI call doesn't have to
 * duplicate the request/response/error-handling boilerplate, and so
 * swapping providers later only touches this one file.
 *
 * Never throws: a summarization feature is a nice-to-have on top of
 * the structured stats applicationSummary.service.js always returns,
 * so a missing key, network hiccup, or malformed model response should
 * degrade to "no AI summary available" rather than fail the whole
 * request.
 */

/**
 * @param {{
 *   jobTitle: string,
 *   jobDescription: string,
 *   skillsRequired: string[],
 *   candidates: Array<{
 *     seekerId: string, fullName: string, bio: string|null,
 *     city: string|null, experienceLevel: string|null,
 *     skills: string[],
 *     experience: Array<{title: string, company: string, description?: string}>,
 *     education: Array<{school: string, degree: string, fieldOfStudy?: string}>,
 *     gpa: number|null,
 *   }>
 * }} params
 * @returns {Promise<{ available: boolean, summaries: Map<string, {summary: string, strengths: string[], fitScore: string}>, error?: string }>}
 */
async function generateApplicantSummaries({ jobTitle, jobDescription, skillsRequired, candidates }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { available: false, summaries: new Map(), error: 'ANTHROPIC_API_KEY is not configured' };
  }

  if (candidates.length === 0) {
    return { available: true, summaries: new Map() };
  }

  const candidateBlocks = candidates.map((c, i) => {
    const experienceLines = (c.experience || [])
      .map((e) => `    - ${e.title} at ${e.company}${e.description ? `: ${e.description}` : ''}`)
      .join('\n');
    const educationLines = (c.education || [])
      .map((e) => `    - ${e.degree}${e.fieldOfStudy ? ` in ${e.fieldOfStudy}` : ''} at ${e.school}`)
      .join('\n');

    return [
      `Candidate ${i + 1} (seekerId: ${c.seekerId})`,
      `  Name: ${c.fullName}`,
      `  City: ${c.city || 'unspecified'}`,
      `  Experience level: ${c.experienceLevel || 'unspecified'}`,
      `  Skills: ${c.skills.join(', ') || 'none listed'}`,
      c.gpa != null ? `  GPA: ${c.gpa.toFixed(2)} / 4.0` : null,
      c.bio ? `  Bio: ${c.bio}` : null,
      experienceLines ? `  Work experience:\n${experienceLines}` : null,
      educationLines ? `  Education:\n${educationLines}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const prompt = `You are helping an employer on an Ethiopian job marketplace quickly review applicants for one job posting.

Job title: ${jobTitle}
Job description: ${jobDescription}
Required skills: ${skillsRequired.join(', ') || 'none specified'}

Applicants:

${candidateBlocks}

For EACH candidate, write a short, neutral, factual 1-2 sentence summary of their fit for this specific job based only on the information given, plus up to 3 concrete strengths relevant to the role, plus a fitScore of "strong", "moderate", or "weak". Where a candidate's GPA is given, weigh it as one factor among several (alongside skills and experience) rather than the deciding one — a strong GPA with weak relevant skills should not automatically outrank solid relevant experience with no GPA listed. Do not invent facts not present above. Do not discuss protected characteristics (age, gender, ethnicity, religion, disability, marital status) even if inferable.

Respond with ONLY a JSON array, no other text, no markdown code fences, in this exact shape:
[{"seekerId": "...", "summary": "...", "strengths": ["...", "..."], "fitScore": "strong"}]`;

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
  } catch (err) {
    return { available: false, summaries: new Map(), error: `Anthropic API request failed: ${err.message}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      available: false,
      summaries: new Map(),
      error: `Anthropic API returned ${response.status}: ${body.slice(0, 300)}`,
    };
  }

  const data = await response.json().catch(() => null);
  const textBlock = data?.content?.find((block) => block.type === 'text');
  if (!textBlock) {
    return { available: false, summaries: new Map(), error: 'No text content in Anthropic response' };
  }

  let parsed;
  try {
    // Models occasionally wrap JSON in a code fence despite instructions
    // not to — strip it defensively rather than failing the whole batch.
    const cleaned = textBlock.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return { available: false, summaries: new Map(), error: `Could not parse Anthropic response as JSON: ${err.message}` };
  }

  if (!Array.isArray(parsed)) {
    return { available: false, summaries: new Map(), error: 'Anthropic response was not a JSON array' };
  }

  const summaries = new Map();
  for (const entry of parsed) {
    if (entry && typeof entry.seekerId === 'string') {
      summaries.set(entry.seekerId, {
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        strengths: Array.isArray(entry.strengths) ? entry.strengths.filter((s) => typeof s === 'string') : [],
        fitScore: ['strong', 'moderate', 'weak'].includes(entry.fitScore) ? entry.fitScore : 'moderate',
      });
    }
  }

  return { available: true, summaries };
}

module.exports = { generateApplicantSummaries };
