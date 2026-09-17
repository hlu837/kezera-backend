'use strict';

const { Technician } = require('../models');
const AppError = require('../errors/AppError');
const {
  EXPERT_TRADE_CATEGORIES,
  EXPERT_TRADE_CATEGORY_LABELS,
} = require('../utils/expertTradeCategories.taxonomy');

/**
 * GET /api/v1/technicians/me
 * @param {string} userId - from req.user.id (JWT sub)
 */
async function getMyProfile(userId) {
  const profile = await Technician.findOne({ userId });
  if (!profile) {
    throw new AppError('Technician profile not found', 404);
  }
  return profile.toJSON();
}

// Wire format (request body / Joi-validated) -> schema field name. Same
// snake_case-in/camelCase-out convention as seeker.service.js's
// UPDATABLE_FIELD_MAP.
const UPDATABLE_FIELD_MAP = {
  full_name: 'fullName',
  trade_category: 'tradeCategory',
  skills: 'skills',
  bio: 'bio',
  city: 'city',
  rate_amount: 'rateAmount',
  rate_unit: 'rateUnit',
};

/**
 * PATCH /api/v1/technicians/me
 * Creates the profile on first call, updates it on every subsequent
 * call — there's no separate "register" endpoint, since the lightweight
 * form (name, trade, location, rate) IS the registration, unlike a
 * Seeker profile which is auto-created at signup and only ever edited
 * here. Upsert also means the choice-screen registration flow and the
 * later "edit my profile" screen can both call this one endpoint.
 *
 * @param {string} userId
 * @param {{ full_name: string, trade_category: string, skills?: string[], bio?: string, city?: string, rate_amount?: number, rate_unit?: string }} updates - already Joi-validated
 */
async function upsertMyProfile(userId, updates) {
  const setDoc = {};
  const unsetDoc = {};

  for (const field of Object.keys(updates)) {
    const modelField = UPDATABLE_FIELD_MAP[field] || field;
    let value = updates[field];
    // '' clears an optional text field back to unset, same convention
    // as seeker.service.js#updateMyProfile.
    if ((field === 'bio' || field === 'city') && value === '') {
      value = null;
    }
    if (value === null) {
      unsetDoc[modelField] = '';
    } else {
      setDoc[modelField] = value;
    }
  }

  const update = {};
  if (Object.keys(setDoc).length > 0) update.$set = setDoc;
  if (Object.keys(unsetDoc).length > 0) update.$unset = unsetDoc;

  const profile = await Technician.findOneAndUpdate(
    { userId },
    update,
    {
      new: true,
      runValidators: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  return profile.toJSON();
}

/**
 * PATCH /api/v1/technicians/me/availability
 * @param {string} userId
 * @param {boolean} availabilityStatus
 */
async function updateAvailability(userId, availabilityStatus) {
  const profile = await Technician.findOneAndUpdate(
    { userId },
    { $set: { availabilityStatus } },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Technician profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * PATCH /api/v1/technicians/me/location
 * Same GeoJSON-mirror-keeping pattern as seeker.service.js#updateLocation
 * — see that function's comment for why the coordinate order flips.
 *
 * @param {string} userId
 * @param {{ latitude: number, longitude: number }} coords - already Joi-validated
 */
async function updateLocation(userId, coords) {
  const { latitude, longitude } = coords;

  const profile = await Technician.findOneAndUpdate(
    { userId },
    {
      $set: {
        latitude,
        longitude,
        location: { type: 'Point', coordinates: [longitude, latitude] },
      },
    },
    { new: true, runValidators: true },
  );

  if (!profile) {
    throw new AppError('Technician profile not found', 404);
  }
  return profile.toJSON();
}

/**
 * GET /api/v1/technicians/nearby (no auth — "Find a technician near you")
 * Guest-facing geo search, same $near + haversine-label pattern as
 * seeker.service.js#nearbySeekers. Only technicians who have granted
 * location access (i.e. have `location` set) are eligible — see the
 * sparse 2dsphere index on Technician.model.js.
 *
 * @param {{
 *   latitude: number, longitude: number, radiusKm: number,
 *   skills?: string[], trade?: string, limit: number
 * }} filters - already Joi-validated (nearbyTechniciansSchema)
 */
const NEARBY_MAX_RESULTS = 100;

async function nearbyTechnicians(filters) {
  const { latitude, longitude, radiusKm, skills, trade, limit } = filters;

  const query = {
    availabilityStatus: true,
    location: {
      $near: {
        $geometry: { type: 'Point', coordinates: [longitude, latitude] },
        $maxDistance: radiusKm * 1000, // $maxDistance is in meters
      },
    },
  };

  if (skills && skills.length > 0) {
    query.skills = { $in: skills };
  }
  if (trade) {
    query.tradeCategory = trade;
  }

  // $near already returns results nearest-first — same note as
  // seeker.service.js#nearbySeekers on why there's no separate $sort.
  const technicians = await Technician.find(query).limit(Math.min(limit, NEARBY_MAX_RESULTS));

  const hydrated = technicians.map((doc) => {
    const json = doc.toJSON();
    json.distanceKm =
      Math.round(
        haversineKm(latitude, longitude, doc.latitude, doc.longitude) * 10,
      ) / 10;
    return json;
  });

  return { technicians: hydrated, count: hydrated.length, radiusKm };
}

/**
 * Great-circle distance between two lat/lng points, in kilometers. Same
 * implementation as seeker.service.js's private helper of the same
 * name — duplicated rather than shared so this service has no
 * dependency on seeker.service.js (the two profile types are meant to
 * stay fully decoupled; see Technician.model.js's top-of-file note).
 */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's mean radius, km
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * GET /api/v1/technicians/trade-categories
 * "Trade Technicians" directory landing page — same always-include-every-
 * category, count-0-for-empty-ones contract as
 * seeker.service.js#getExpertCategoryCounts.
 *
 * @returns {Promise<Array<{ key: string, label: string, count: number }>>}
 */
async function getTradeCategoryCounts() {
  const rows = await Technician.aggregate([
    { $match: { availabilityStatus: true } },
    { $group: { _id: '$tradeCategory', count: { $sum: 1 } } },
  ]);

  const countsByKey = rows.reduce((acc, row) => {
    acc[row._id] = row.count;
    return acc;
  }, {});

  return EXPERT_TRADE_CATEGORIES.map(({ key, label }) => ({
    key,
    label: EXPERT_TRADE_CATEGORY_LABELS[key] || label,
    count: countsByKey[key] || 0,
  }));
}

module.exports = {
  getMyProfile,
  upsertMyProfile,
  updateAvailability,
  updateLocation,
  nearbyTechnicians,
  getTradeCategoryCounts,
};
