import catalog from './client-profiles.json';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const CLIENT_PROFILES = freeze(catalog.builds);
export function clientProfile(build) {
  return CLIENT_PROFILES.find(profile => profile.appVersion === build?.appVersion && profile.buildNumber === String(build?.buildNumber));
}
