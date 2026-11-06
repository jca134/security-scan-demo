import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";

import { storeAuthorization, takeAuthorization, validAuthorization } from "../web/auth-handoff.js";

const browser = new JSDOM("", { url: "https://filecrawler.test/" });
globalThis.sessionStorage = browser.window.sessionStorage;

describe("one-navigation OAuth handoff", () => {
  beforeEach(() => sessionStorage.clear());

  it("returns a valid token once and immediately removes storage", () => {
    storeAuthorization({ accessToken: "token", mode: "content", expiresAt: 20_000 });
    assert.deepEqual(takeAuthorization(10_000), {
      accessToken: "token",
      mode: "content",
      expiresAt: 20_000,
    });
    assert.equal(takeAuthorization(10_000), null);
  });

  it("rejects expired or malformed handoffs", () => {
    storeAuthorization({ accessToken: "token", mode: "sharing", expiresAt: 5_000 });
    assert.equal(takeAuthorization(10_000), null);
    sessionStorage.setItem("filecrawler-oauth-handoff", "not json");
    assert.equal(takeAuthorization(10_000), null);
  });
});

describe("popup authorization validation", () => {
  it("accepts only well-formed, unexpired tokens", () => {
    const good = { accessToken: "token", mode: "content", expiresAt: 20_000 };
    assert.equal(validAuthorization(good, 10_000), good);
    assert.equal(validAuthorization({ ...good, expiresAt: 5_000 }, 10_000), null);
    assert.equal(validAuthorization({ ...good, mode: "admin" }, 10_000), null);
    assert.equal(validAuthorization({ ...good, accessToken: 42 }, 10_000), null);
    assert.equal(validAuthorization(null, 10_000), null);
  });
});
