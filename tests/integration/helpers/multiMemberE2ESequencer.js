// Milestone 5C.7 - forces a deterministic cross-file test order for the
// full multi-member end-to-end validation suite, mirroring the 5C.4/5C.5
// suite's own financialSequencer.js and the 5C.6 suite's own
// reconciliationSequencer.js pattern exactly (same mechanism, own
// ORDER). Jest's default sequencer does NOT guarantee alphabetical/
// declaration order - this suite needs a STRICT order instead: the
// pure, emulator-free guard unit test runs FIRST; then the one
// continuous healthy-lifecycle scenario; then the final summary.
// Combined with jest.multi-member-e2e.config.js's `bail: 1`, this
// guarantees "5C.7: PASS" can never print unless the lifecycle test has
// already fully passed.
const Sequencer = require('@jest/test-sequencer').default;

const ORDER = [
  'integrationGuard',
  'multiMemberLifecycle',
  'zzz_5c7_summary',
];

class MultiMemberE2ESequencer extends Sequencer {
  sort(tests) {
    const indexOf = (test) => {
      const idx = ORDER.findIndex((name) => test.path.includes(name));
      return idx === -1 ? ORDER.length : idx;
    };
    return [...tests].sort((a, b) => indexOf(a) - indexOf(b));
  }
}

module.exports = MultiMemberE2ESequencer;
