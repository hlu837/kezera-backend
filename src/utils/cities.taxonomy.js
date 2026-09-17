'use strict';

/**
 * Ethiopian cities/towns the CV parser scans for when auto-filling
 * Seeker.city. Ordered roughly by population/likelihood so that if a
 * CV mentions more than one place (e.g. hometown + current city),
 * extractCity() in cvParser.service.js favors the more common city
 * when it has to pick between two equally-early matches — see that
 * function's tie-break comment.
 *
 * Free-text field on the model (Seeker.model.js), same as skills —
 * this list only seeds it, it doesn't constrain it.
 */
const CITIES_TAXONOMY = [
  'Addis Ababa', 'Dire Dawa', 'Mekelle', 'Adama', 'Nazret', 'Nazareth',
  'Bahir Dar', 'Hawassa', 'Awassa', 'Gondar', 'Jimma', 'Dessie',
  'Jijiga', 'Shashamane', 'Bishoftu', 'Debre Zeit', 'Sodo', 'Arba Minch',
  'Hosaena', 'Harar', 'Dilla', 'Nekemte', 'Debre Birhan', 'Debre Markos',
  'Kombolcha', 'Adigrat', 'Ambo', 'Asella', 'Woldiya', 'Bonga',
  'Gambela', 'Assosa', 'Semera', 'Wolaita Sodo', 'Debre Tabor',
  'Weldiya', 'Robe', 'Goba', 'Bale Robe', 'Metu', 'Nekemte',
  'Butajira', 'Ziway', 'Batu', 'Shire', 'Axum', 'Aksum', 'Alamata',
  'Maychew', 'Wukro', 'Finote Selam', 'Fiche', 'Sebeta', 'Burayu',
  'Holeta', 'Gimbi', 'Bedele', 'Chiro', 'Dembi Dolo', 'Moyale',
  'Negele Borana', 'Yirgalem', 'Wolkite', 'Durame', 'Hagere Maryam',
  'Ginir', 'Jinka', 'Mizan Teferi', 'Areka', 'Boditi', 'Alaba',
];

module.exports = { CITIES_TAXONOMY };
