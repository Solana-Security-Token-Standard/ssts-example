import test from "node:test";
import {
  addWhitelistEntry,
  assertFails,
  buildSstsTransferIx,
  createScenario,
  deriveWhitelistEntryPda,
  removeWhitelistEntry,
  sendTx,
  shouldRunE2E,
} from "./helpers";

// Run serially to keep RPC pressure low and test output deterministic.
const SERIAL = { concurrency: false } as const;

test(
  "cpi: transfer fails when verification context accounts are missing",
  SERIAL,
  async (t) => {
    if (!shouldRunE2E()) {
      t.skip();
      return;
    }

    const scenario = await createScenario("cpi");
    await addWhitelistEntry(scenario, scenario.ataB);

    // CPI mode requires verifier context on the transfer instruction itself.
    await assertFails(async () => {
      await sendTx(scenario.connection, scenario.payer, [
        buildSstsTransferIx(scenario),
      ]);
    }, "SSTS CPI transfer should fail when whitelist verification context is missing");
  },
);

test(
  "cpi: transfer remains blocked even with whitelist context (core account-shape limit)",
  SERIAL,
  async (t) => {
    if (!shouldRunE2E()) {
      t.skip();
      return;
    }

    const scenario = await createScenario("cpi");

    await addWhitelistEntry(scenario, scenario.ataB);

    // Documents current on-chain behavior in the deployed core:
    // even with context, transfer is blocked by core account-shape checks.
    await assertFails(async () => {
      await sendTx(scenario.connection, scenario.payer, [
        buildSstsTransferIx(scenario, { includeContext: true }),
      ]);
    }, "SSTS CPI transfer currently fails in core transfer execution even when verifier context is present");

    await removeWhitelistEntry(scenario, scenario.ataB);
  },
);

test("cpi: malformed verification context fails", SERIAL, async (t) => {
  if (!shouldRunE2E()) {
    t.skip();
    return;
  }

  const scenario = await createScenario("cpi");
  await addWhitelistEntry(scenario, scenario.ataB);

  const malformedEntry = deriveWhitelistEntryPda(
    scenario.whitelistConfigPda,
    scenario.ataA,
    scenario.whitelistProgramId,
  );

  // Wrong whitelist entry PDA should fail even when context accounts are present.
  await assertFails(async () => {
    await sendTx(scenario.connection, scenario.payer, [
      buildSstsTransferIx(scenario, {
        includeContext: true,
        contextEntry: malformedEntry,
      }),
    ]);
  }, "SSTS CPI transfer should fail when whitelist verification context is malformed");
});
