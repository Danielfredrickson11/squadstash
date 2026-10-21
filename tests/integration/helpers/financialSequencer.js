// Milestone 5C.4/5C.5 - forces a deterministic cross-file test order for
// the multi-member financial integration suite, mirroring the invitation
// suite's own sequencer.js pattern exactly (same mechanism, own ORDER).
// Jest's default sequencer does NOT guarantee alphabetical/declaration
// order - this suite needs a STRICT order instead: the pure, emulator-
// free guard unit test runs FIRST (a guard regression must be caught
// before any real emulator work starts); then every 5C.4 scenario; then
// the 5C.4 summary; then every 5C.5 scenario; then the 5C.5 summary.
// Combined with jest.financial-integration.config.js's `bail: 1`, this
// guarantees: a guard failure means no financial test ever runs; a 5C.4
// failure means neither "5C.4: PASS" nor any 5C.5 file runs; a 5C.4
// success prints "5C.4: PASS" and that banner is never retroactively
// invalidated by a later 5C.5 failure; "5C.5: PASS" only ever prints
// once every 5C.5 assertion has already passed. There is never one
// combined final banner - 5C.4 and 5C.5 remain separate roadmap
// milestones with separate PASS criteria.
const Sequencer = require('@jest/test-sequencer').default;

const ORDER = [
  'integrationGuard',
  'sharedStashSpending',
  'zzz_5c4_summary',
  'ownershipWithdrawal',
  'zzz_5c5_summary',
];

class MultiMemberFinancialIntegrationSequencer extends Sequencer {
  sort(tests) {
    const indexOf = (test) => {
      const idx = ORDER.findIndex((name) => test.path.includes(name));
      return idx === -1 ? ORDER.length : idx;
    };
    return [...tests].sort((a, b) => indexOf(a) - indexOf(b));
  }
}

module.exports = MultiMemberFinancialIntegrationSequencer;
