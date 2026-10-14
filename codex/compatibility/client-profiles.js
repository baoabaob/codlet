import catalog from './client-profiles.json';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const CLIENT_PROFILES = freeze(catalog.builds);
export function clientProfile(build, entries = []) {
  const candidates = CLIENT_PROFILES.filter(profile => profile.appVersion === build?.appVersion && profile.buildNumber === String(build?.buildNumber));
  if (candidates.length === 1) return candidates[0];
  const sources = Array.isArray(entries) ? entries : [entries];
  const matches = candidates.filter(profile => sources.includes(profile.entry));
  return matches.length === 1 ? matches[0] : undefined;
}
