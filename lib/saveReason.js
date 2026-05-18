// Runtime validator for the Phase 1 mandatory `saveReason` discriminator
// on every pin-write path. The client side gets compile-time enforcement
// via TypeScript; the server has to fall back to a runtime assertion.
//
// Every server entry point that ends in a Pin write — buildPinFromDetails,
// any future bulk import, etc. — must call `assertSaveReason(reason)`
// before any side effect. Throwing pre-write means an invalid value cannot
// leave the system in a half-saved state.

const VALID = ['manual', 'clone', 'enrichment'];

function assertSaveReason(reason) {
  if (!VALID.includes(reason)) {
    throw new Error(
      `Invalid saveReason: ${JSON.stringify(reason)}. Must be one of ${VALID.join(', ')}.`,
    );
  }
}

module.exports = { assertSaveReason, VALID };
