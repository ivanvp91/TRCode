/** Post-fix regression checks; historical evidence is in docs/audit/.
 * Run after npm run build: node scripts/audit-repro.mjs
 * Only owned temp files and local mock providers; no payment.
 */
await import("../test/audit-regression-test.mjs");
