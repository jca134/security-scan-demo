import { AUTH_CHANNEL, storeAuthorization } from "./auth-handoff.js";
import { GOOGLE_CLIENT_ID, googleClientConfigured } from "./config.js";
import { CONTENT_SCOPE, METADATA_SCOPE } from "./drive.js";

const button = document.querySelector("#authorize-button");
const status = document.querySelector("#authorization-status");
const description = document.querySelector("#authorization-description");
const searchParams = new URLSearchParams(location.search);
const requestedMode = searchParams.get("mode");
// popup=1: opened from the scanner to upgrade access without reloading it.
const popupMode = searchParams.get("popup") === "1";
const cancelLink = document.querySelector("#cancel-link");
let handedOff = false;

function announce(message) {
  const channel = new BroadcastChannel(AUTH_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

if (popupMode) {
  cancelLink.textContent = "Cancel";
  cancelLink.addEventListener("click", (event) => {
    event.preventDefault();
    window.close();
  });
  // Tell the scanner tab if this window closes without granting access.
  addEventListener("pagehide", () => {
    if (!handedOff) announce({ type: "cancelled" });
  });
}
const mode = requestedMode === "content" ? "content" : "sharing";
const scope = mode === "content" ? CONTENT_SCOPE : METADATA_SCOPE;

description.textContent = mode === "content"
  ? "This session requests read-only Drive access. File content is read only after a permission check shows the file is shared with someone else. Private files are never read."
  : "This session requests metadata-only Drive access. File contents cannot be downloaded with this authorization.";

function showError(message) {
  status.textContent = message;
  status.className = "error";
  button.disabled = false;
  button.textContent = "Try authorization again";
}

function waitForGoogle(timeoutMs = 10_000) {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (globalThis.google?.accounts?.oauth2) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Google Identity Services did not load. Check content blockers and your network connection."));
      }
    }, 50);
  });
}

async function initialize() {
  if (!googleClientConfigured()) {
    showError("This deployment is missing GOOGLE_CLIENT_ID. Configure it in the Cloudflare Pages build environment and redeploy.");
    button.disabled = true;
    return;
  }
  try {
    await waitForGoogle();
    button.disabled = false;
    status.textContent = "Google is ready. Authorization opens in a secure Google dialog.";
  } catch (error) {
    showError(error.message);
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Waiting for Google…";
  status.className = "";
  status.textContent = "Choose an account and approve the requested permission.";

  try {
    await waitForGoogle();
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope,
      include_granted_scopes: false,
      callback: (response) => {
        if (response.error || !response.access_token) {
          showError(response.error_description || response.error || "Google did not return an access token.");
          return;
        }
        if (!google.accounts.oauth2.hasGrantedAllScopes(response, scope)) {
          showError("The requested Drive permission was not granted.");
          return;
        }
        const expiresIn = Number(response.expires_in || 0);
        const authorization = {
          accessToken: response.access_token,
          expiresAt: Date.now() + Math.max(0, expiresIn - 30) * 1000,
          mode,
        };
        if (popupMode) {
          handedOff = true;
          announce({ type: "authorized", authorization });
          status.textContent = "Access granted. You can close this window.";
          window.close();
          return;
        }
        storeAuthorization(authorization);
        location.replace("./");
      },
      error_callback: (error) => {
        const messages = {
          popup_closed: "The Google authorization dialog was closed.",
          popup_failed_to_open: "The browser blocked the Google authorization dialog. Allow popups and try again.",
        };
        showError(messages[error.type] || "Google authorization could not start.");
      },
    });
    client.requestAccessToken({ prompt: "select_account" });
  } catch (error) {
    showError(error.message);
  }
});

initialize();
