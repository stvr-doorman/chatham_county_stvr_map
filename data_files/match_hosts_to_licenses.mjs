import fs from 'node:fs';
import vm from 'node:vm';

const LISTINGS_FILE = 'unincorporated_locations.js';
const LICENSES_FILE = 'county_licensed_locations.geojson';
const OUTPUT_FILE = 'unincorporated_locations_matched_hosts.js';
const UNLICENSED_RESEARCH_FILE = 'county_unlicensed_airbnbs.csv';
const SEARCH_RADIUS_METERS = 1100;

const listingsContext = {};
vm.createContext(listingsContext);
vm.runInContext(`${fs.readFileSync(LISTINGS_FILE, 'utf8')}\nthis.__locations = locations;`, listingsContext);
const listings = listingsContext.__locations;
const licenseGeoJson = JSON.parse(fs.readFileSync(LICENSES_FILE, 'utf8'));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(field); field = '';
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
    } else field += character;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map(valuesRow => Object.fromEntries(headers.map((header, index) => [header, valuesRow[index] || ''])));
}

function listingIdFromUrl(url) {
  return String(url || '').match(/rooms\/(\d+)/)?.[1] || '';
}

const confirmedUnlicensedListingIds = new Set(
  parseCsv(fs.readFileSync(UNLICENSED_RESEARCH_FILE, 'utf8'))
    .map(row => listingIdFromUrl(row.airbnb_url))
    .filter(Boolean)
);

const ignoredTokens = new Set([
  'AND', 'THE', 'A', 'AN', 'OF', 'DBA', 'LLC', 'LTD', 'INC', 'CORP', 'CO',
  'COMPANY', 'TRUST', 'ESTATE', 'PROPERTIES', 'PROPERTY', 'MANAGEMENT',
  'RENTALS', 'RENTAL', 'HOLDINGS', 'INVESTMENTS', 'GROUP', 'SERVICES',
  'DR', 'MR', 'MRS', 'MS', 'JR', 'SR', 'II', 'III', 'IV'
]);

const nameVariantGroups = [
  ['ALEXANDER', 'ALEX', 'XANDER'], ['ALEXANDRA', 'ALEX', 'LEXI'],
  ['ANTHONY', 'TONY'], ['BENJAMIN', 'BEN'], ['CHARLES', 'CHARLIE', 'CHUCK'],
  ['CHRISTOPHER', 'CHRIS'], ['DANIEL', 'DAN', 'DANNY'], ['DAVID', 'DAVE'],
  ['EDWARD', 'ED', 'EDDIE', 'TED'], ['ELIZABETH', 'LIZ', 'BETH', 'LIZZY'],
  ['FRANCIS', 'FRANK'], ['FREDERICK', 'FRED', 'FREDDIE'], ['GREGORY', 'GREG'],
  ['JACOB', 'JAKE'], ['JAMES', 'JIM', 'JIMMY'], ['JENNIFER', 'JEN', 'JENNY'],
  ['JOHN', 'JOHNNY', 'JACK'], ['JOSEPH', 'JOE', 'JOEY'], ['KATHERINE', 'KATHRYN', 'KATE', 'KATIE', 'KATHY'],
  ['MARGARET', 'MAGGIE', 'MEG', 'PEGGY'], ['MATTHEW', 'MATT'], ['MICHAEL', 'MIKE'],
  ['NICHOLAS', 'NICK'], ['PATRICIA', 'PAT', 'PATTY'], ['REBECCA', 'BECKY', 'BECCA'],
  ['RICHARD', 'RICK', 'RICH', 'DICK'], ['ROBERT', 'ROB', 'BOB', 'BOBBY'],
  ['SAMUEL', 'SAM'], ['STEPHEN', 'STEVEN', 'STEVE'],
  ['SUSAN', 'SUSANNE', 'SUZANNE', 'SUE', 'SUSIE', 'SUZY'],
  ['THOMAS', 'TOM', 'TOMMY'], ['WILLIAM', 'WILL', 'BILL', 'BILLY']
];
const canonicalNameToken = new Map();
nameVariantGroups.forEach(group => group.forEach(token => canonicalNameToken.set(token, group[0])));

function canonicalToken(token) {
  return canonicalNameToken.get(token) || token;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function meaningfulTokens(value) {
  return normalizeName(value).split(' ').filter(token =>
    token.length >= 3 && !ignoredTokens.has(token)
  );
}

function haversineMeters(first, second) {
  const radians = degrees => degrees * Math.PI / 180;
  const latitudeDelta = radians(second.latitude - first.latitude);
  const longitudeDelta = radians(second.longitude - first.longitude);
  const latitude1 = radians(first.latitude);
  const latitude2 = radians(second.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function levenshtein(first, second) {
  const previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let firstIndex = 1; firstIndex <= first.length; firstIndex++) {
    let diagonal = previous[0];
    previous[0] = firstIndex;
    for (let secondIndex = 1; secondIndex <= second.length; secondIndex++) {
      const old = previous[secondIndex];
      previous[secondIndex] = Math.min(
        previous[secondIndex] + 1,
        previous[secondIndex - 1] + 1,
        diagonal + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1)
      );
      diagonal = old;
    }
  }
  return previous[second.length];
}

function similarity(first, second) {
  if (!first && !second) return 1;
  const longest = Math.max(first.length, second.length);
  return longest ? 1 - (levenshtein(first, second) / longest) : 0;
}

function classifyNameMatch(hostName, businessName) {
  const host = normalizeName(hostName);
  const business = normalizeName(businessName);
  const hostTokens = meaningfulTokens(hostName);
  const businessTokens = meaningfulTokens(businessName);
  const canonicalHostTokens = hostTokens.map(canonicalToken);
  const canonicalBusinessTokens = businessTokens.map(canonicalToken);
  if (!host || !business || !hostTokens.length || !businessTokens.length) return null;

  if (host === business) return { match_type: 'exact_full_name', confidence: 'high', score: 1 };
  if (host.length >= 5 && (` ${business} `).includes(` ${host} `)) {
    return { match_type: 'complete_name_in_license', confidence: 'high', score: 0.97 };
  }

  const allHostTokensPresent = hostTokens.length >= 2 && hostTokens.every(token => businessTokens.includes(token));
  if (allHostTokensPresent) {
    return { match_type: 'all_host_name_tokens', confidence: 'high', score: 0.94 };
  }

  if (hostTokens.length === 1 && hostTokens[0].length >= 4 && businessTokens.includes(hostTokens[0])) {
    return { match_type: 'one_name_match', confidence: 'medium', score: 0.78 };
  }

  const prefixTokenMatch = (hostToken, businessToken) =>
    hostToken.length >= 4 && businessToken.length >= 4 &&
    (hostToken.startsWith(businessToken) || businessToken.startsWith(hostToken));
  if (hostTokens.length === 1 && businessTokens.some(token => prefixTokenMatch(hostTokens[0], token))) {
    return { match_type: 'one_name_prefix_match', confidence: 'medium', score: 0.74 };
  }
  if (hostTokens.length >= 2 && hostTokens.every(hostToken =>
    businessTokens.some(businessToken => prefixTokenMatch(hostToken, businessToken)))) {
    return { match_type: 'all_name_prefix_matches', confidence: 'medium', score: 0.86 };
  }

  const allVariantsPresent = canonicalHostTokens.length >= 1 &&
    canonicalHostTokens.every(token => canonicalBusinessTokens.includes(token));
  if (allVariantsPresent) {
    return {
      match_type: hostTokens.length === 1 ? 'one_name_variant_match' : 'all_name_variants_match',
      confidence: hostTokens.length === 1 ? 'medium' : 'high',
      score: hostTokens.length === 1 ? 0.75 : 0.9
    };
  }

  const sharedTokens = hostTokens.filter(token => token.length >= 4 && businessTokens.includes(token));
  if (sharedTokens.length) {
    return { match_type: 'partial_name_match', confidence: 'low', score: 0.66 };
  }

  if (hostTokens.length >= 2) {
    const tokenScores = hostTokens.map(hostToken =>
      Math.max(...businessTokens.map(businessToken => similarity(hostToken, businessToken)))
    );
    const minimumTokenScore = Math.min(...tokenScores);
    const averageTokenScore = tokenScores.reduce((sum, value) => sum + value, 0) / tokenScores.length;
    if (minimumTokenScore >= 0.84 && averageTokenScore >= 0.9) {
      return { match_type: 'fuzzy_name_match', confidence: 'medium', score: Number(averageTokenScore.toFixed(4)) };
    }
  }

  if (hostTokens.length === 1 && hostTokens[0].length >= 5) {
    const bestTokenScore = Math.max(...businessTokens.map(token => similarity(hostTokens[0], token)));
    if (bestTokenScore >= 0.86) {
      return { match_type: 'fuzzy_one_name_match', confidence: 'low', score: Number(bestTokenScore.toFixed(4)) };
    }
  }

  return null;
}

const licenses = (licenseGeoJson.features || []).map(feature => {
  const [longitude, latitude] = feature.geometry?.coordinates || [];
  return { ...feature.properties, longitude, latitude };
}).filter(license => Number.isFinite(license.longitude) && Number.isFinite(license.latitude));

function publicCandidate(license, nameMatch, distanceMeters) {
  return {
    match_type: nameMatch.match_type,
    confidence: nameMatch.confidence,
    name_similarity_score: nameMatch.score,
    distance_meters: Number(distanceMeters.toFixed(1)),
    within_1km: distanceMeters <= 1000,
    distance_band: distanceMeters <= 1000 ? 'within_1km' : '1km_to_1.1km_buffer',
    license_number: license.licenseNumber || license['Business License Number'] || '',
    license_business_name: license['Business Name'] || '',
    license_address: license.matchedAddress || license.Parcel_Matched_Address || license.DBA || '',
    license_longitude: license.longitude,
    license_latitude: license.latitude
  };
}

const enrichedListings = listings.map(listing => {
  const isConfirmedUnlicensed = listing.license_status === 'unlicensed' ||
    confirmedUnlicensedListingIds.has(listingIdFromUrl(listing.url));
  if (isConfirmedUnlicensed) {
    return {
      ...listing,
      host_license_match: {
        matched: false,
        match_type: 'excluded_confirmed_unlicensed',
        confidence: 'none',
        search_radius_meters: SEARCH_RADIUS_METERS,
        candidate_count: 0,
        exclusion_reason: 'confirmed_unlicensed_research_status'
      },
      host_license_candidates: []
    };
  }

  const candidates = licenses.flatMap(license => {
    const distanceMeters = haversineMeters(listing, license);
    if (distanceMeters > SEARCH_RADIUS_METERS) return [];
    const nameMatch = classifyNameMatch(listing.host_name, license['Business Name']);
    if (nameMatch && ['partial_name_match', 'fuzzy_one_name_match'].includes(nameMatch.match_type) && distanceMeters > 500) return [];
    return nameMatch ? [publicCandidate(license, nameMatch, distanceMeters)] : [];
  }).sort((first, second) =>
    second.name_similarity_score - first.name_similarity_score ||
    first.distance_meters - second.distance_meters
  );

  const best = candidates[0] || null;
  return {
    ...listing,
    host_license_match: best ? {
      matched: true,
      search_radius_meters: SEARCH_RADIUS_METERS,
      candidate_count: candidates.length,
      ...best
    } : {
      matched: false,
      match_type: 'none',
      confidence: 'none',
      search_radius_meters: SEARCH_RADIUS_METERS,
      candidate_count: 0
    },
    host_license_candidates: candidates
  };
});

fs.writeFileSync(
  OUTPUT_FILE,
  `const locations = ${JSON.stringify(enrichedListings, null, 2)};\n`,
  'utf8'
);

const summary = enrichedListings.reduce((result, listing) => {
  const type = listing.host_license_match.match_type;
  result[type] = (result[type] || 0) + 1;
  return result;
}, {});

console.log(JSON.stringify({
  output: OUTPUT_FILE,
  listings: enrichedListings.length,
  licenses: licenses.length,
  search_radius_meters: SEARCH_RADIUS_METERS,
  match_types: summary
}, null, 2));
