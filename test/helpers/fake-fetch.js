"use strict";
/**
 * Minimal fetch-response stand-ins for testing src/client.js without touching the network.
 * No dependency, just plain objects shaped like what `res.text()` / `res.headers.get()` need.
 */

function fakeResponse(status, bodyText, headers = {}) {
  const lower = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    status,
    text: async () => bodyText,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
  };
}

function jsonResponse(status, body, headers = {}) {
  return fakeResponse(status, JSON.stringify(body), headers);
}

/** Queue of canned responses/fns; each call to fetch() consumes the next one. */
function queuedFetch(items) {
  let i = 0;
  return async (...args) => {
    if (i >= items.length) throw new Error("fake fetch queue exhausted");
    const item = items[i++];
    if (typeof item === "function") return item(...args);
    if (item instanceof Error) throw item;
    return item;
  };
}

module.exports = { fakeResponse, jsonResponse, queuedFetch };
