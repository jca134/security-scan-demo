/* global __GOOGLE_CLIENT_ID__ */

export const GOOGLE_CLIENT_ID = __GOOGLE_CLIENT_ID__;

export function googleClientConfigured() {
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(GOOGLE_CLIENT_ID);
}
