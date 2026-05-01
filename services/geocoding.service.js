/**
 * Geocoding Service — wraps the Google Maps Geocoding API.
 *
 * Resolves a free-text address (typically the patient's full home address)
 * into latitude / longitude. Used during patient creation and on every
 * address update so the home-therapy live-map and distance/route logic
 * always have current coordinates.
 *
 * Failures (no result, missing API key, network error) are swallowed and
 * surfaced as `null` so callers can persist the typed address with
 * locationVerified = false rather than block the patient save on a
 * Google API outage.
 */

import { Client } from '@googlemaps/google-maps-services-js';
import logger from '../lib/logger.js';

const client = new Client({});

/**
 * Compose a single-line address string from the structured Patient fields.
 * Empty pieces are dropped so we never send "Chennai, , Tamil Nadu, ".
 */
export function composeAddress({ addressLine1, addressLine2, city, state, pincode }) {
  return [addressLine1, addressLine2, city, state, pincode]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join(', ');
}

/**
 * @param {string} address — full address string (e.g. "12, Anna Nagar, Chennai, Tamil Nadu, 600001")
 * @returns {Promise<{lat:number,lng:number}|null>}
 */
export async function geocodeAddress(address) {
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return null;
  }
  const rawKey = process.env.GOOGLE_MAPS_SERVER_KEY;
  // Treat placeholder strings (used in .env templates) as "unset" so we
  // don't waste a network round-trip and surface a misleading 403.
  const key = rawKey && !/^REPLACE_WITH_/i.test(rawKey) ? rawKey : null;
  if (!key) {
    if (logger?.warn) {
      logger.warn('[geocoding] GOOGLE_MAPS_SERVER_KEY not set — skipping geocode');
    } else {
      console.warn('[geocoding] GOOGLE_MAPS_SERVER_KEY not set — skipping geocode');
    }
    return null;
  }
  try {
    const res = await client.geocode({
      params: { address, key },
      timeout: 5000,
    });
    if (!res?.data?.results?.length) return null;
    const loc = res.data.results[0].geometry?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
    return { lat: loc.lat, lng: loc.lng };
  } catch (err) {
    const msg = err?.response?.data?.error_message || err?.message || String(err);
    if (logger?.warn) {
      logger.warn(`[geocoding] geocode failed for address="${address}": ${msg}`);
    } else {
      console.warn(`[geocoding] geocode failed: ${msg}`);
    }
    return null;
  }
}

/**
 * Convenience helper used during patient create/update — composes the
 * address from structured fields and returns
 * { latitude, longitude, locationVerified }.
 */
export async function geocodePatientAddress(addressFields) {
  const composed = composeAddress(addressFields);
  if (!composed) {
    return { latitude: null, longitude: null, locationVerified: false };
  }
  const result = await geocodeAddress(composed);
  if (!result) {
    return { latitude: null, longitude: null, locationVerified: false };
  }
  return {
    latitude: result.lat,
    longitude: result.lng,
    locationVerified: true,
  };
}
