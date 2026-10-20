// Checkpoint 5C.3D-B - the real Firestore Web SDK's WebChannel transport
// needs a working XMLHttpRequest global to perform actual client reads
// (confirmed empirically - httpsCallable's own fetch-based transport
// works fine without this, but getDoc/onSnapshot do not). The RN Jest
// environment jest-expo's preset provides does not supply one. `jsdom`
// is already an installed (transitive) dependency of this project's own
// Jest tooling - no new npm dependency is added here, per the frozen
// preflight's own "no new npm dependency unless absolutely unavoidable"
// instruction. This file ONLY ever runs under jest.integration.config.js
// (via its own setupFiles) - it has no effect on the production app, the
// root unit-test config, or the Rules-test config.
const {JSDOM} = require("jsdom");

if (typeof global.XMLHttpRequest === "undefined") {
  const dom = new JSDOM("", {url: "http://127.0.0.1/"});
  global.XMLHttpRequest = dom.window.XMLHttpRequest;
}
