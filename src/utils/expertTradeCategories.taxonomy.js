'use strict';

/**
 * Individual skilled-trade categories for the "Experts" directory
 * (electricians, plumbers, etc. — people offering permanent, contract,
 * or temporary trade work, found via GPS proximity rather than posting
 * to/applying for a job listing).
 *
 * Deliberately a separate taxonomy from JOB_CATEGORY_KEYS
 * (jobCategories.taxonomy.js), which is the broad bucket set standard
 * job postings and `Seeker.preferredCategories` use (e.g.
 * "construction_labor" covers many trades at once) — the Experts
 * directory needs per-trade granularity so "Electricians · 12" and
 * "Plumbers · 8" can be browsed and counted separately.
 */
const EXPERT_TRADE_CATEGORIES = [
  { key: 'electrician', label: 'Electricians' },
  { key: 'plumber', label: 'Plumbers' },
  { key: 'carpenter', label: 'Carpenters' },
  { key: 'mason', label: 'Masons' },
  { key: 'painter', label: 'Painters' },
  { key: 'mechanic', label: 'Mechanics' },
  { key: 'welder', label: 'Welders' },
  { key: 'tailor', label: 'Tailors' },
  { key: 'hairdresser_beautician', label: 'Hairdressers & Beauticians' },
  { key: 'gardener_landscaper', label: 'Gardeners & Landscapers' },
  { key: 'appliance_repair', label: 'Appliance Repair Techs' },
  { key: 'cleaner', label: 'Cleaners' },
  { key: 'other_trade', label: 'Other Trades' },
];

const EXPERT_TRADE_CATEGORY_KEYS = EXPERT_TRADE_CATEGORIES.map((c) => c.key);

const EXPERT_TRADE_CATEGORY_LABELS = EXPERT_TRADE_CATEGORIES.reduce((acc, c) => {
  acc[c.key] = c.label;
  return acc;
}, {});

module.exports = {
  EXPERT_TRADE_CATEGORIES,
  EXPERT_TRADE_CATEGORY_KEYS,
  EXPERT_TRADE_CATEGORY_LABELS,
};
