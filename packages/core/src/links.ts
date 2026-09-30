/**
 * Link rules shared by the engine, the route handlers and the browser (ADR-0027). No dependencies, so client code
 * imports it as `@mimic/core/links` without pulling in the engine.
 */

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A web link we render as a link or send to search: http(s), with a dotted host. */
export function isWebLink(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** People type "linkedin.com/in/you": adds https:// when a link has no scheme. */
export function withScheme(link: string): string {
  const v = link.trim();
  return !v || SCHEME.test(v) ? v : `https://${v}`;
}

/** The host to show for a link: "linkedin.com". */
export function hostLabel(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Query parameters that describe a visit rather than a page. */
const TRACKING = /^(?:utm_.*|mc_.*|fbclid|gclid|ref|ref_src|si|trk|trkinfo|lipi|originalsubdomain)$/i;

/**
 * A profile URL's identity, for dedupe and for matching the person's own link. The scheme, `www.`, a trailing
 * slash and tracking parameters don't count; other query parameters do (`facebook.com/profile.php?id=…`). Every
 * LinkedIn host (country and mobile subdomains) is the same site, and its profile paths are case-insensitive.
 */
export function profileKey(url: string): string {
  let u: URL;
  try {
    u = new URL(withScheme(url));
  } catch {
    return url.trim().toLowerCase();
  }
  let host = u.hostname.replace(/^www\./, '');
  const linkedin = /(?:^|\.)linkedin\.com$/.test(host);
  if (linkedin) host = 'linkedin.com';
  const path = u.pathname.replace(/\/+$/, '');
  const params = linkedin
    ? []
    : [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${host}${linkedin ? path.toLowerCase() : path}${query}`;
}
