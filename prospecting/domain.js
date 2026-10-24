// prospecting/domain.js — website URL → dealership identity
//
// Dealerships are deduplicated on the normalized host: lowercase, no scheme,
// no port, no leading www/www2/m. The full host is kept (not the registrable
// domain) because many dealers live on shared platform hosts such as
// <dealer>.wixsite.com — collapsing to the registrable domain would merge
// unrelated stores.

// Hosts that are never a dealership's own website.
const NON_DEALER_HOSTS = [
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'linkedin.com',
  'google.com', 'business.site', 'g.page', 'goo.gl', 'maps.app.goo.gl', 'linktr.ee', 'bit.ly',
  'yelp.com', 'yellowpages.com', 'bbb.org', 'mapquest.com', 'manta.com', 'nextdoor.com', 'foursquare.com',
  'cars.com', 'cargurus.com', 'autotrader.com', 'carfax.com', 'dealerrater.com', 'edmunds.com',
  'kbb.com', 'truecar.com', 'craigslist.org', 'carsforsale.com', 'autolist.com', 'offerup.com',
  // Manufacturer sites. Map listings often point a rooftop at its OEM, which would
  // merge hundreds of unrelated dealers into one record.
  'ford.com', 'lincoln.com', 'toyota.com', 'lexus.com', 'honda.com', 'acura.com', 'chevrolet.com', 'gmc.com',
  'buick.com', 'cadillac.com', 'gm.com', 'nissanusa.com', 'infinitiusa.com', 'hyundaiusa.com', 'genesis.com',
  'kia.com', 'subaru.com', 'mazdausa.com', 'vw.com', 'audiusa.com', 'bmwusa.com', 'mbusa.com', 'porsche.com',
  'volvocars.com', 'jeep.com', 'ramtrucks.com', 'dodge.com', 'chrysler.com', 'mopar.com', 'stellantis.com',
  'mitsubishicars.com', 'tesla.com', 'rivian.com', 'lucidmotors.com', 'polestar.com', 'landroverusa.com',
  'jaguarusa.com', 'maserati.com', 'alfaromeousa.com', 'fiatusa.com', 'miniusa.com', 'harley-davidson.com'
];

function hostOf(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let url;
  try { url = new URL(s); } catch (e) { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.indexOf('.') === -1 || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  host = host.replace(/^(www\d*|m)\./, '');
  return host;
}

function isNonDealerHost(host) {
  return NON_DEALER_HOSTS.some(function (h) { return host === h || host.endsWith('.' + h); });
}

// Returns { domain, websiteUrl } or null when the URL is not usable as a dealer site.
function normalizeWebsite(raw) {
  const domain = hostOf(raw);
  if (!domain || isNonDealerHost(domain)) return null;
  return { domain, websiteUrl: 'https://' + domain + '/' };
}

const US_STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
  'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR').split(' '));

function normalizeState(raw) {
  const s = String(raw || '').trim().toUpperCase();
  return US_STATES.has(s) ? s : null;
}

module.exports = { normalizeWebsite, normalizeState, hostOf, isNonDealerHost, US_STATES };
