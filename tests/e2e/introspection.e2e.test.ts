import test from "node:test";
import {
  addWhitelistEntry,
  assertFails,
  buildIntrospectionVerificationIx,
  buildSstsTransferIx,
  createScenario,
  deriveWhitelistEntryPda,
  removeWhitelistEntry,
  sendTx,
  shouldRunE2E,
} from "./helpers";

// Run serially to reduce RPC burst and make failure order easy to read in CI logs.
const SERIAL = { concurrency: false } as const;

test(
  "introspection: transfer fails without verification instruction",
  SERIAL,
  async (t) => {
    if (!shouldRunE2E()) {
      t.skip();
      return;
    }

    const scenario = await createScenario("introspection");
    await addWhitelistEntry(scenario, scenario.ataB);

    // Missing verification instruction should block transfer in introspection mode.
    await assertFails(async () => {
      await sendTx(scenario.connection, scenario.payer, [
        buildSstsTransferIx(scenario),
      ]);
    }, "SSTS transfer should fail when introspection verification instruction is missing");
  },
);

test(
  "introspection: transfer fails when verification context accounts are missing",
  SERIAL,
  async (t) => {
    if (!shouldRunE2E()) {
      t.skip();
      return;
    }

    const scenario = await createScenario("introspection");
    await addWhitelistEntry(scenario, scenario.ataB);

    // Verifier instruction exists, but required whitelist context is intentionally omitted.
    await assertFails(async () => {
      await sendTx(scenario.connection, scenario.payer, [
        buildIntrospectionVerificationIx(scenario, {
          omitConfig: true,
          omitEntry: true,
        }),
        buildSstsTransferIx(scenario),
      ]);
    }, "SSTS transfer should fail when verification context accounts are omitted");
  },
);

test("introspection: whitelist add/remove controls transfer", SERIAL, async (t) => {
  if (!shouldRunE2E()) {
    t.skip();
    return;
  }

  const scenario = await createScenario("introspection");

  // No whitelist entry -> transfer must fail.
  await assertFails(async () => {
    await sendTx(scenario.connection, scenario.payer, [
      buildIntrospectionVerificationIx(scenario),
      buildSstsTransferIx(scenario),
    ]);
  }, "SSTS transfer should fail before whitelist entry is added");

  await addWhitelistEntry(scenario, scenario.ataB);

  // Entry present -> transfer should pass.
  await sendTx(scenario.connection, scenario.payer, [
    buildIntrospectionVerificationIx(scenario),
    buildSstsTransferIx(scenario),
  ]);

  await removeWhitelistEntry(scenario, scenario.ataB);

  // Entry removed again -> transfer must fail.
  await assertFails(async () => {
    await sendTx(scenario.connection, scenario.payer, [
      buildIntrospectionVerificationIx(scenario),
      buildSstsTransferIx(scenario),
    ]);
  }, "SSTS transfer should fail after whitelist entry is removed");
});

test("introspection: malformed verification context fails", SERIAL, async (t) => {
  if (!shouldRunE2E()) {
    t.skip();
    return;
  }

  const scenario = await createScenario("introspection");
  await addWhitelistEntry(scenario, scenario.ataB);

  const malformedEntry = deriveWhitelistEntryPda(
    scenario.whitelistConfigPda,
    scenario.ataA,
    scenario.whitelistProgramId,
  );

  // Entry PDA must match destination account. A mismatched entry must be rejected.
  await assertFails(async () => {
    await sendTx(scenario.connection, scenario.payer, [
      buildIntrospectionVerificationIx(scenario, { entry: malformedEntry }),
      buildSstsTransferIx(scenario),
    ]);
  }, "SSTS transfer should fail when verification context entry does not match destination");
});
