// Checkpoint 5C.3D-B - forces a deterministic cross-file test order for
// the integration suite. Jest's default sequencer does NOT guarantee
// alphabetical/declaration order (it prioritizes previously-failed
// tests, then file size, as a parallelization heuristic) - this suite
// needs a STRICT order instead: the pure, emulator-free guard unit tests
// (integrationGuard) run FIRST, so a guard regression is caught before
// any real emulator work starts; then the data/backend/Rules scenarios
// (tripInvitationFlow); then the real screen render
// (tripInvitationScreen); then the final summary (zzz_summary) -
// combined with jest.integration.config.js's `bail: 1`, this guarantees
// the summary file's "5C.3D: PASS" line can only ever print once every
// earlier file has already fully passed.
const Sequencer = require('@jest/test-sequencer').default;

const ORDER = ['integrationGuard', 'tripInvitationFlow', 'tripInvitationScreen', 'zzz_summary'];

class TripInvitationIntegrationSequencer extends Sequencer {
  sort(tests) {
    const indexOf = (test) => {
      const idx = ORDER.findIndex((name) => test.path.includes(name));
      return idx === -1 ? ORDER.length : idx;
    };
    return [...tests].sort((a, b) => indexOf(a) - indexOf(b));
  }
}

module.exports = TripInvitationIntegrationSequencer;
