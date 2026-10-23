/**
 * Visitor geolocation from local MaxMind GeoLite2 databases.
 *
 * jrok is the one place that sees every visitor's verified address, so it is
 * the one place that needs the databases: the result travels to the agent with
 * each request (`clientGeo` on `http_request`), and whoever consumes the
 * agent's request events (kconsole's deploy worker) gets location for free
 * instead of every worker host keeping its own copy up to date.
 *
 * The files are maintained by `geoipupdate` (cron, twice a week) in GEOIP_DIR.
 * Readers watch their file and swap in the new data when it changes, so an
 * update never needs a restart.
 *
 * Lookups are in-memory and cached; there is no I/O on the request path. When a
 * database is missing the lookup returns undefined and requests flow exactly as
 * before — location is enrichment, never a dependency.
 */
import { existsSync } from "fs";
import { join } from "path";
import maxmind, { type AsnResponse, type CityResponse, type Reader } from "maxmind";

export interface ClientGeo {
  /** ISO 3166-1 alpha-2 */
  country?: string;
  city?: string;
  region?: string;
  asn?: number;
  /** Network operator / ISP, from the ASN database */
  org?: string;
}

const GEOIP_DIR = process.env.GEOIP_DIR || "/var/lib/GeoIP";

// Most traffic comes from a small set of addresses; the readers' LRU keeps
// repeat lookups to a Map hit. Bounded, because the key space is every IP that
// ever reaches us.
const CACHE = { max: 20000 };

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;

async function openReader<T extends CityResponse | AsnResponse>(
  names: string[]
): Promise<Reader<T> | null> {
  for (const name of names) {
    const file = join(GEOIP_DIR, name);
    if (!existsSync(file)) continue;
    try {
      const reader = await maxmind.open<T>(file, {
        cache: CACHE,
        watchForUpdates: true,
        watchForUpdatesNonPersistent: true,
        watchForUpdatesHook: () => console.log(`🌍 GeoIP: reloaded ${name}`),
      });
      console.log(`🌍 GeoIP: loaded ${file}`);
      return reader;
    } catch (error) {
      console.warn(`⚠️ GeoIP: could not open ${file}:`, (error as Error)?.message || error);
    }
  }
  return null;
}

/**
 * Load the databases. Safe to call without them installed: lookups then return
 * undefined. A commercial GeoIP2 file is preferred when both are present.
 */
export async function initGeoip(): Promise<void> {
  [cityReader, asnReader] = await Promise.all([
    openReader<CityResponse>(["GeoIP2-City.mmdb", "GeoLite2-City.mmdb"]),
    openReader<AsnResponse>(["GeoIP2-ISP.mmdb", "GeoLite2-ASN.mmdb"]),
  ]);
  if (!cityReader && !asnReader) {
    console.log(`🌍 GeoIP: no databases in ${GEOIP_DIR}; visitor location disabled`);
  }
}

/**
 * Location for a verified visitor address, or undefined when unknown (private
 * and loopback addresses, "unknown", or no database loaded).
 */
export function lookupGeo(ip: string | null | undefined): ClientGeo | undefined {
  if (!ip || ip === "unknown" || (!cityReader && !asnReader)) return undefined;
  if (!maxmind.validate(ip)) return undefined;

  const geo: ClientGeo = {};
  try {
    const city = cityReader?.get(ip);
    if (city) {
      const country = city.country?.iso_code || city.registered_country?.iso_code;
      if (country) geo.country = country;
      const cityName = city.city?.names?.en;
      if (cityName) geo.city = cityName;
      const region = city.subdivisions?.[0]?.names?.en;
      if (region) geo.region = region;
    }
    const asn = asnReader?.get(ip);
    if (asn?.autonomous_system_number) {
      geo.asn = asn.autonomous_system_number;
      if (asn.autonomous_system_organization) geo.org = asn.autonomous_system_organization;
    }
  } catch {
    // A malformed record must never fail the request it describes.
    return undefined;
  }

  return Object.keys(geo).length > 0 ? geo : undefined;
}
