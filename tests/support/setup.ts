// Vitest setup file (vitest.config.ts): every test file runs with these.

// The pods cache's fsync calls are skipped (src/pods/durable.ts): on a busy disk they stall the tests that write many
// small cache files. tests/pods/durable.test.ts checks that rn-xtool syncs without it.
process.env.RN_XTOOL_NO_FSYNC = "1";
