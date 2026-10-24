// prospecting/discovery.js — Dealership Hunter: bulk import + dedupe
//
// Source records (Overture today; any DiscoverySource later) arrive in batches.
// Each batch is normalized in JS, then written with a handful of set-based
// statements, so importing ~130k records is minutes, not hours.
//
// Identity = normalized website host (see domain.js). Several source records
// with one host (a group's rooftops, duplicate map pins) become ONE dealership
// with location_count = number of distinct source records.

const { normalizeWebsite, normalizeState } = require('./domain');

const NATIONAL_CHAIN_MIN = 25;

const MAKES = [
  ['Toyota'], ['Honda'], ['Ford'], ['Chevrolet', 'Chevy'], ['Nissan'], ['Hyundai'], ['Kia'], ['Subaru'],
  ['Mazda'], ['Volkswagen', 'VW'], ['BMW'], ['Mercedes-Benz', 'Mercedes'], ['Audi'], ['Lexus'], ['Acura'],
  ['Infiniti'], ['Cadillac'], ['Buick'], ['GMC'], ['Chrysler'], ['Dodge'], ['Jeep'], ['Ram'], ['Lincoln'],
  ['Volvo'], ['Porsche'], ['Jaguar'], ['Land Rover'], ['Mitsubishi'], ['Genesis'], ['Alfa Romeo'], ['Fiat'],
  ['Maserati'], ['MINI'], ['Polestar'], ['CDJR'], ['Harley-Davidson']
];
const MAKE_PATTERNS = MAKES.map(function (names) {
  return {
    brand: names[0],
    re: new RegExp('\\b(' + names.map(function (n) { return n.replace(/[-]/g, '[- ]?'); }).join('|') + ')\\b', 'i')
  };
});

function brandsFromName(name) {
  const out = [];
  for (const p of MAKE_PATTERNS) {
    if (p.re.test(name || '')) out.push(p.brand === 'CDJR' ? 'Chrysler' : p.brand);
  }
  return Array.from(new Set(out));
}

function dealershipType(category, brands) {
  if (brands.length) return 'franchise';
  if (category === 'used_auto_dealer') return 'independent';
  return 'unknown';
}

// Primary IANA zone per state (the zone most of its population is in).
const STATE_TZ = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles',
  CO: 'America/Denver', CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise', IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago', ME: 'America/New_York',
  MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago', NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York', ND: 'America/Chicago',
  OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', UT: 'America/Denver',
  VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York', WI: 'America/Chicago',
  WY: 'America/Denver', PR: 'America/Puerto_Rico'
};

function firstUsableSite(websites) {
  for (const w of websites || []) {
    const n = normalizeWebsite(w);
    if (n) return n;
  }
  return null;
}

// records: [{ id, name, category, websites[], phones[], street, city, region, postcode, lat, lon,
//             operating_status, license }]
async function importDealerBatch(pool, source, records, actor) {
  const stats = { received: records.length, skippedClosed: 0, skippedNoSite: 0, skippedNoState: 0,
                  newDealerships: 0, newLocations: 0, alreadyKnown: 0 };
  const byDomain = new Map();
  const sources = [];

  for (const r of records) {
    if (!r || !r.id || !r.name) continue;
    if (r.operating_status === 'permanently_closed' || r.operating_status === 'temporarily_closed') { stats.skippedClosed++; continue; }
    const site = firstUsableSite(r.websites);
    if (!site) { stats.skippedNoSite++; continue; }
    const state = normalizeState(r.region);
    if (!state) { stats.skippedNoState++; continue; }

    const name = String(r.name).trim().slice(0, 200);
    const brands = brandsFromName(name);
    if (!byDomain.has(site.domain)) {
      byDomain.set(site.domain, {
        name, domain: site.domain, websiteUrl: site.websiteUrl,
        phone: (r.phones && r.phones[0]) || null,
        street: r.street || null, city: r.city || null, state, postcode: r.postcode || null,
        lat: typeof r.lat === 'number' ? r.lat : null, lon: typeof r.lon === 'number' ? r.lon : null,
        timezone: STATE_TZ[state] || null,
        type: dealershipType(r.category, brands), brands
      });
    }
    sources.push({ domain: site.domain, id: String(r.id), license: r.license || null, name,
                   street: r.street || null, city: r.city || null, state, postcode: r.postcode || null,
                   category: r.category || null });
  }

  const dealers = Array.from(byDomain.values());
  if (!dealers.length) return stats;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO px_dealerships (name, domain, website_url, phone, street, city, state, postcode, lat, lon,
                                   timezone, dealership_type, franchise_brands)
       SELECT u.name, u.domain, u.website_url, u.phone, u.street, u.city, u.state, u.postcode, u.lat, u.lon,
              u.timezone, u.dtype, COALESCE(string_to_array(NULLIF(u.brands, ''), '|'), '{}')
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::float8[], $10::float8[], $11::text[], $12::text[], $13::text[])
              AS u(name, domain, website_url, phone, street, city, state, postcode, lat, lon, timezone, dtype, brands)
       ON CONFLICT (domain) WHERE domain IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        dealers.map(d => d.name), dealers.map(d => d.domain), dealers.map(d => d.websiteUrl), dealers.map(d => d.phone),
        dealers.map(d => d.street), dealers.map(d => d.city), dealers.map(d => d.state), dealers.map(d => d.postcode),
        dealers.map(d => d.lat), dealers.map(d => d.lon), dealers.map(d => d.timezone), dealers.map(d => d.type),
        dealers.map(d => d.brands.join('|'))
      ]
    );
    stats.newDealerships = ins.rowCount;
    stats.alreadyKnown = dealers.length - ins.rowCount;

    const ids = await client.query(`SELECT id, domain FROM px_dealerships WHERE domain = ANY($1::text[])`, [dealers.map(d => d.domain)]);
    const idByDomain = new Map(ids.rows.map(r => [r.domain, r.id]));

    const src = await client.query(
      `INSERT INTO px_dealership_sources (dealership_id, source, source_record_id, license, name, street, city, state, postcode, category)
       SELECT u.dealership_id, $1, u.rid, u.license, u.name, u.street, u.city, u.state, u.postcode, u.category
         FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
              AS u(dealership_id, rid, license, name, street, city, state, postcode, category)
       ON CONFLICT (source, source_record_id) DO NOTHING
       RETURNING dealership_id`,
      [
        source,
        sources.map(s => idByDomain.get(s.domain)), sources.map(s => s.id), sources.map(s => s.license),
        sources.map(s => s.name), sources.map(s => s.street), sources.map(s => s.city), sources.map(s => s.state),
        sources.map(s => s.postcode), sources.map(s => s.category)
      ]
    );
    stats.newLocations = src.rowCount;

    const touched = Array.from(new Set(src.rows.map(r => r.dealership_id)));
    if (touched.length) {
      await client.query(
        `UPDATE px_dealerships d
            SET location_count = GREATEST(1, (SELECT COUNT(*) FROM px_dealership_sources s WHERE s.dealership_id = d.id)),
                updated_at = NOW()
          WHERE d.id = ANY($1::bigint[])`,
        [touched]
      );
      // 5+ rooftops on one site = a dealer group. NATIONAL_CHAIN_MIN+ = a national
      // chain (CarMax, DriveTime...) whose staff we never cold-email.
      await client.query(
        `UPDATE px_dealerships
            SET dealership_type = CASE WHEN location_count >= 5 THEN 'group' ELSE dealership_type END,
                status = CASE WHEN location_count >= $2 AND status = 'DISCOVERED' THEN 'DO_NOT_CONTACT' ELSE status END,
                disqualify_reason = CASE WHEN location_count >= $2 AND status = 'DISCOVERED'
                                         THEN 'national chain (' || $2 || '+ locations on one site)' ELSE disqualify_reason END
          WHERE id = ANY($1::bigint[])`,
        [touched, NATIONAL_CHAIN_MIN]
      );
    }

    await client.query(
      `INSERT INTO px_events (event_type, actor, detail) VALUES ('dealerships_imported', $1, $2)`,
      [actor, JSON.stringify(Object.assign({ source }, stats))]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(function () {});
    throw e;
  } finally {
    client.release();
  }
  return stats;
}

// Dealer sites the extension is already built for (its store whitelist). Their
// platform is known-good, so they skip the fingerprint check. This says nothing
// about whether anyone there is a customer — that is checked per person.
async function markSupportedDealers(pool, domains) {
  if (!domains || !domains.length) return 0;
  const r = await pool.query(
    `UPDATE px_dealerships
        SET platform_supported = TRUE, platform = COALESCE(platform, 'autopost_whitelist'),
            platform_checked_at = COALESCE(platform_checked_at, NOW()), updated_at = NOW()
      WHERE domain = ANY($1::text[])`,
    [domains]
  );
  return r.rowCount;
}

module.exports = { importDealerBatch, markSupportedDealers, brandsFromName, STATE_TZ };
