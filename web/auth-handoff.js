const HANDOFF_KEY = "filecrawler-oauth-handoff";

// Same-origin channel used when authorize.html runs in a popup and hands a
// broader token back to the already-open scanner tab without a page reload.
export const AUTH_CHANNEL = "privacy-scanner-auth";

export function validAuthorization(authorization, now = Date.now()) {
  if (
    !authorization
    || typeof authorization.accessToken !== "string"
    || !["sharing", "content"].includes(authorization.mode)
    || !Number.isFinite(authorization.expiresAt)
    || authorization.expiresAt <= now
  ) {
    return null;
  }
  return authorization;
}

export function storeAuthorization(authorization) {
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(authorization));
}

export function takeAuthorization(now = Date.now()) {
  const serialized = sessionStorage.getItem(HANDOFF_KEY);
  sessionStorage.removeItem(HANDOFF_KEY);
  if (!serialized) return null;

  try {
    return validAuthorization(JSON.parse(serialized), now);
  } catch {
    return null;
  }
}
