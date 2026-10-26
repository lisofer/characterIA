// Browser Origin must be either this service's own origin or an explicitly
// authorized PlayCanvas origin. Never require users to add their Railway
// domain to APP_ORIGINS just to save profiles in the panel served by Railway.
export function originAllowed(origin, host, configuredOrigins = new Set()) {
  if (typeof origin !== 'string' || !origin) return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.origin !== origin || parsed.username || parsed.password) return false;
  if (configuredOrigins.has(origin)) return true;
  if (!host || typeof host !== 'string') return false;
  const normalizedHost = host.toLowerCase();
  if (parsed.host.toLowerCase() !== normalizedHost) return false;
  const local = /^((localhost)|(127\.0\.0\.1)|(\[::1\]))(:\d+)?$/.test(normalizedHost);
  return parsed.protocol === 'https:' || (local && parsed.protocol === 'http:');
}
