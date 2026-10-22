// Milestone 5C.6 - forces a deterministic cross-file test order for the
// reversal/reconciliation hardening integration suite, mirroring the
// 5C.4/5C.5 suite's own financialSequencer.js pattern exactly (same
// mechanism, own ORDER). Jest's default sequencer does NOT guarantee
// alphabetical/declaration order - this suite needs a STRICT order
// instead: the pure, emulator-free guard unit test runs FIRST; then the
// recordSavingsTransaction hardening scenarios; then the Shared-Stash
// reversal regression; then the non-ownership reversal regression; then
// the reconciliation-recovery (admin-tool) scenarios; then the final
// summary. Combined with jest.reconciliation-integration.config.js's
// `bail: 1`, this guarantees "5C.6: PASS" can never print once any
// upstream file has failed.
const Sequencer = require('@jest/test-sequencer').default;

const ORDER = [
  'integrationGuard',
  'reconciliationHardening',
  'sharedStashReversalHardening',
  'nonOwnershipReversalRegression',
  'reconciliationRecovery',
  'zzz_5c6_summary',
];

class ReconciliationIntegrationSequencer extends Sequencer {
  sort(tests) {
    const indexOf = (test) => {
      const idx = ORDER.findIndex((name) => test.path.includes(name));
      return idx === -1 ? ORDER.length : idx;
    };
    return [...tests].sort((a, b) => indexOf(a) - indexOf(b));
  }
}

module.exports = ReconciliationIntegrationSequencer;
