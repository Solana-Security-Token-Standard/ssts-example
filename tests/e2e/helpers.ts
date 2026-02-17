import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  addExtraAccountMetasForExecute,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// Shared e2e helpers for issuer-template flows.
// Keep these primitives reusable so new issuers can copy one file and adapt quickly.
export type Cluster = "localnet" | "devnet" | "testnet" | "mainnet";
export type VerificationMode = "introspection" | "cpi";

// RPC behavior can be tuned via env when running on flaky/shared endpoints.
const RPC_MAX_ATTEMPTS = envPositiveInt("RPC_MAX_ATTEMPTS", 8);
const RPC_BASE_DELAY_MS = envPositiveInt("RPC_BASE_DELAY_MS", 350);
const RPC_MAX_DELAY_MS = envPositiveInt("RPC_MAX_DELAY_MS", 5_000);
const RPC_CONFIRM_TIMEOUT_MS = envPositiveInt("RPC_CONFIRM_TIMEOUT_MS", 90_000);
const RPC_CONFIRM_POLL_MS = envPositiveInt("RPC_CONFIRM_POLL_MS", 700);
const TX_MAX_ATTEMPTS = envPositiveInt("TX_MAX_ATTEMPTS", 3);

type ProgramIds = {
  securityTokenProgram: string | null;
  transferHookProgram: string | null;
  transferWhitelistProgram: string | null;
};

type ProgramIdsResolved = {
  securityTokenProgram: string;
  transferHookProgram: string;
  transferWhitelistProgram: string;
};

export const DISCRIMINATORS = {
  initializeMint: 0,
  initializeVerificationConfig: 2,
  mint: 6,
  transfer: 12,
} as const;

export const WHITELIST_DISCRIMINATORS = {
  initialize: 200,
  add: 201,
  remove: 202,
} as const;

export type Scenario = {
  cluster: Cluster;
  mode: VerificationMode;
  connection: Connection;
  payer: Keypair;
  securityProgramId: PublicKey;
  transferHookProgramId: PublicKey;
  whitelistProgramId: PublicKey;
  mint: Keypair;
  investorA: Keypair;
  investorB: Keypair;
  mintAuthorityPda: PublicKey;
  freezeAuthorityPda: PublicKey;
  verificationConfigMintPda: PublicKey;
  verificationConfigTransferPda: PublicKey;
  transferHookPda: PublicKey;
  accountMetasPda: PublicKey;
  permanentDelegatePda: PublicKey;
  whitelistConfigPda: PublicKey;
  ataA: PublicKey;
  ataB: PublicKey;
  decimals: number;
};

function envPositiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableRpcError(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("rate limit") ||
    message.includes("gateway timeout") ||
    message.includes("service unavailable") ||
    message.includes("socket hang up") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("timeout") ||
    message.includes("node is behind") ||
    message.includes("blockhash not found") ||
    message.includes("block height exceeded") ||
    message.includes("expired before confirmation")
  );
}

// Centralized retry wrapper so all RPC actions share the same backoff policy.
async function withRpcRetry<T>(action: string, fn: () => Promise<T>): Promise<T> {
  let delayMs = RPC_BASE_DELAY_MS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error) || attempt === RPC_MAX_ATTEMPTS) {
        throw error;
      }
      const jitter = Math.floor(Math.random() * 120);
      await sleep(Math.min(delayMs + jitter, RPC_MAX_DELAY_MS));
      delayMs = Math.min(Math.floor(delayMs * 1.8), RPC_MAX_DELAY_MS);
    }
  }

  throw new Error(
    `RPC retry loop exhausted for ${action}: ${errorMessage(lastError)}`,
  );
}

// Poll confirmation explicitly instead of using websocket subscriptions.
// This keeps tests deterministic on public RPC providers that throttle websocket traffic.
async function waitForSignatureConfirmation(
  connection: Connection,
  signature: string,
  options?: {
    lastValidBlockHeight?: number;
    timeoutMs?: number;
  },
) {
  const timeoutMs = options?.timeoutMs ?? RPC_CONFIRM_TIMEOUT_MS;
  const startedAt = Date.now();
  let pollCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const statuses = await withRpcRetry("getSignatureStatuses", () =>
      connection.getSignatureStatuses([signature], {
        searchTransactionHistory: false,
      }),
    );
    const status = statuses.value[0];
    if (status?.err) {
      throw new Error(
        `Transaction ${signature} failed: ${JSON.stringify(status.err)}`,
      );
    }
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return;
    }

    if (options?.lastValidBlockHeight !== undefined && pollCount % 3 === 0) {
      const blockHeight = await withRpcRetry("getBlockHeight", () =>
        connection.getBlockHeight("confirmed"),
      );
      if (blockHeight > options.lastValidBlockHeight) {
        throw new Error(`Transaction ${signature} expired before confirmation`);
      }
    }

    pollCount += 1;
    await sleep(RPC_CONFIRM_POLL_MS);
  }

  throw new Error(`Transaction ${signature} not confirmed before timeout`);
}

function resolveCluster(): Cluster {
  const cluster = (process.env.CLUSTER ?? "devnet").toLowerCase();
  if (
    cluster === "localnet" ||
    cluster === "devnet" ||
    cluster === "testnet" ||
    cluster === "mainnet"
  ) {
    return cluster;
  }
  throw new Error(
    `Unsupported CLUSTER=${cluster}. Expected localnet|devnet|testnet|mainnet.`,
  );
}

function loadProgramIds(cluster: Cluster): ProgramIdsResolved {
  const configPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../config/program-ids.json",
  );
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<Cluster, ProgramIds>;
  const entry = parsed[cluster];
  if (
    !entry?.securityTokenProgram ||
    !entry?.transferHookProgram ||
    !entry?.transferWhitelistProgram
  ) {
    throw new Error(
      `Missing program IDs for ${cluster}. Update ${configPath}.`,
    );
  }

  return {
    securityTokenProgram: entry.securityTokenProgram,
    transferHookProgram: entry.transferHookProgram,
    transferWhitelistProgram: entry.transferWhitelistProgram,
  };
}

function clusterUrl(cluster: Cluster) {
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  if (cluster === "mainnet") {
    return "https://api.mainnet-beta.solana.com";
  }
  return `https://api.${cluster}.solana.com`;
}

function loadKeypair(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const secret = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secret);
}

function resolvePayer(): Keypair {
  const explicit = process.env.SOLANA_KEYPAIR;
  const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
  return loadKeypair(explicit ?? defaultPath);
}

function u32le(value: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function u64le(value: bigint) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value, 0);
  return buf;
}

function encodeString(value: string) {
  const data = Buffer.from(value, "utf8");
  return Buffer.concat([u32le(data.length), data]);
}

function encodeInitializeMintArgs(input: {
  decimals: number;
  mintAuthority: PublicKey;
  freezeAuthority: PublicKey;
  metadataPointer?: {
    authority: PublicKey;
    metadataAddress: PublicKey;
  } | null;
  metadata?: {
    name: string;
    symbol: string;
    uri: string;
    additionalMetadata?: Uint8Array;
  } | null;
}) {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([input.decimals]));
  parts.push(input.mintAuthority.toBuffer());
  parts.push(input.freezeAuthority.toBuffer());

  if (input.metadataPointer) {
    parts.push(Buffer.from([1]));
    parts.push(input.metadataPointer.authority.toBuffer());
    parts.push(input.metadataPointer.metadataAddress.toBuffer());
  } else {
    parts.push(Buffer.from([0]));
  }

  if (input.metadata) {
    const additional = input.metadata.additionalMetadata ?? new Uint8Array();
    parts.push(Buffer.from([1]));
    parts.push(encodeString(input.metadata.name));
    parts.push(encodeString(input.metadata.symbol));
    parts.push(encodeString(input.metadata.uri));
    parts.push(
      Buffer.concat([u32le(additional.length), Buffer.from(additional)]),
    );
  } else {
    parts.push(Buffer.from([0]));
  }

  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeInitializeVerificationConfigArgs(input: {
  instructionDiscriminator: number;
  cpiMode: boolean;
  programAddresses: PublicKey[];
}) {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([input.instructionDiscriminator]));
  parts.push(Buffer.from([input.cpiMode ? 1 : 0]));
  parts.push(u32le(input.programAddresses.length));
  for (const program of input.programAddresses) {
    parts.push(program.toBuffer());
  }
  return Buffer.concat(parts);
}

async function ensureProgramExecutable(
  connection: Connection,
  programId: PublicKey,
): Promise<void> {
  const info = await withRpcRetry("getAccountInfo(program)", () =>
    connection.getAccountInfo(programId, "confirmed"),
  );
  if (!info) {
    throw new Error(`Program account not found: ${programId.toBase58()}`);
  }
  if (!info.executable) {
    throw new Error(`Account is not executable: ${programId.toBase58()}`);
  }
}

async function maybeAirdrop(
  connection: Connection,
  payer: Keypair,
  cluster: Cluster,
) {
  if (cluster !== "devnet" && cluster !== "localnet") {
    return;
  }
  const balance = await withRpcRetry("getBalance", () =>
    connection.getBalance(payer.publicKey, "confirmed"),
  );
  if (balance >= 0.5 * 1e9) {
    return;
  }
  const signature = await withRpcRetry("requestAirdrop", () =>
    connection.requestAirdrop(payer.publicKey, 1e9),
  );
  await waitForSignatureConfirmation(connection, signature, {
    timeoutMs: RPC_CONFIRM_TIMEOUT_MS,
  });
}

export async function sendTx(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  signers: Keypair[] = [],
) {
  // Rebuild/sign each attempt to avoid stale blockhashes during retries.
  for (let attempt = 1; attempt <= TX_MAX_ATTEMPTS; attempt += 1) {
    try {
      const tx = new Transaction();
      tx.add(...instructions);
      tx.feePayer = payer.publicKey;
      const latest = await withRpcRetry("getLatestBlockhash", () =>
        connection.getLatestBlockhash("confirmed"),
      );
      tx.recentBlockhash = latest.blockhash;
      tx.sign(payer, ...signers);

      const signature = await withRpcRetry("sendRawTransaction", () =>
        connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 0,
          preflightCommitment: "confirmed",
        }),
      );

      await waitForSignatureConfirmation(connection, signature, {
        lastValidBlockHeight: latest.lastValidBlockHeight,
        timeoutMs: RPC_CONFIRM_TIMEOUT_MS,
      });

      return signature;
    } catch (error) {
      if (!isRetryableRpcError(error) || attempt === TX_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(Math.min(RPC_BASE_DELAY_MS * attempt * 2, RPC_MAX_DELAY_MS));
    }
  }

  throw new Error("unreachable");
}

async function ensureAssociatedTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
) {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const info = await withRpcRetry("getAccountInfo(ata)", () =>
    connection.getAccountInfo(ata, "confirmed"),
  );
  if (!info) {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    await sendTx(connection, payer, [ix]);
  }
  return ata;
}

export function shouldRunE2E() {
  return process.env.RUN_SSTS_E2E === "1";
}

export async function assertFails(
  action: () => Promise<unknown>,
  message: string,
) {
  // Do not treat infra/rate-limit errors as an expected functional failure.
  let failed = false;
  try {
    await action();
  } catch (error) {
    if (isRetryableRpcError(error)) {
      throw error;
    }
    failed = true;
  }
  assert.ok(failed, message);
}

export function deriveWhitelistEntryPda(
  whitelistConfigPda: PublicKey,
  tokenAccount: PublicKey,
  whitelistProgramId: PublicKey,
) {
  const [entry] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("whitelist-entry"),
      whitelistConfigPda.toBuffer(),
      tokenAccount.toBuffer(),
    ],
    whitelistProgramId,
  );
  return entry;
}

export function buildSstsTransferIx(
  scenario: Scenario,
  options?: {
    amount?: bigint;
    destination?: PublicKey;
    includeContext?: boolean;
    contextConfig?: PublicKey;
    contextEntry?: PublicKey;
  },
) {
  // Security Token `Transfer` instruction account layout.
  // Optional whitelist context can be appended when a verifier expects it.
  const amount = options?.amount ?? 1n;
  const destination = options?.destination ?? scenario.ataB;
  const keys = [
    { pubkey: scenario.mint.publicKey, isSigner: false, isWritable: false },
    {
      pubkey: scenario.verificationConfigTransferPda,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: scenario.permanentDelegatePda,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: scenario.mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: scenario.ataA, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    {
      pubkey: scenario.transferHookProgramId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  if (options?.includeContext) {
    keys.push({
      pubkey: options.contextConfig ?? scenario.whitelistConfigPda,
      isSigner: false,
      isWritable: false,
    });
    keys.push({
      pubkey:
        options.contextEntry ??
        deriveWhitelistEntryPda(
          scenario.whitelistConfigPda,
          destination,
          scenario.whitelistProgramId,
        ),
      isSigner: false,
      isWritable: false,
    });
    keys.push({
      pubkey: scenario.whitelistProgramId,
      isSigner: false,
      isWritable: false,
    });
  }

  return new TransactionInstruction({
    programId: scenario.securityProgramId,
    data: Buffer.concat([Buffer.from([DISCRIMINATORS.transfer]), u64le(amount)]),
    keys,
  });
}

export function buildIntrospectionVerificationIx(
  scenario: Scenario,
  options?: {
    amount?: bigint;
    destination?: PublicKey;
    config?: PublicKey;
    entry?: PublicKey;
    omitConfig?: boolean;
    omitEntry?: boolean;
  },
) {
  // Explicit verification call used in introspection mode.
  // This instruction must appear before the SSTS transfer in the same transaction.
  const amount = options?.amount ?? 1n;
  const destination = options?.destination ?? scenario.ataB;
  const keys = [
    {
      pubkey: scenario.permanentDelegatePda,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: scenario.mint.publicKey, isSigner: false, isWritable: false },
    { pubkey: scenario.ataA, isSigner: false, isWritable: true },
    { pubkey: destination, isSigner: false, isWritable: true },
    {
      pubkey: scenario.transferHookProgramId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  if (!options?.omitConfig) {
    keys.push({
      pubkey: options?.config ?? scenario.whitelistConfigPda,
      isSigner: false,
      isWritable: false,
    });
  }
  if (!options?.omitEntry) {
    keys.push({
      pubkey:
        options?.entry ??
        deriveWhitelistEntryPda(
          scenario.whitelistConfigPda,
          destination,
          scenario.whitelistProgramId,
        ),
      isSigner: false,
      isWritable: false,
    });
  }

  return new TransactionInstruction({
    programId: scenario.whitelistProgramId,
    data: Buffer.concat([Buffer.from([DISCRIMINATORS.transfer]), u64le(amount)]),
    keys,
  });
}

export async function createDirectTransferCheckedIx(
  scenario: Scenario,
  options?: {
    amount?: bigint;
    destination?: PublicKey;
    includeContext?: boolean;
    contextConfig?: PublicKey;
    contextEntry?: PublicKey;
    omitConfig?: boolean;
    omitEntry?: boolean;
  },
) {
  // Direct Token-2022 path:
  // build a normal transfer and then append transfer-hook extra metas.
  const amount = options?.amount ?? 1n;
  const destination = options?.destination ?? scenario.ataB;

  const ix = createTransferCheckedInstruction(
    scenario.ataA,
    scenario.mint.publicKey,
    destination,
    scenario.investorA.publicKey,
    amount,
    scenario.decimals,
    [],
    TOKEN_2022_PROGRAM_ID,
  );

  if (options?.includeContext) {
    // Additional verifier context accounts can be pre-attached.
    if (!options.omitConfig) {
      ix.keys.push({
        pubkey: options.contextConfig ?? scenario.whitelistConfigPda,
        isSigner: false,
        isWritable: false,
      });
    }
    if (!options.omitEntry) {
      ix.keys.push({
        pubkey:
          options.contextEntry ??
          deriveWhitelistEntryPda(
            scenario.whitelistConfigPda,
            destination,
            scenario.whitelistProgramId,
          ),
        isSigner: false,
        isWritable: false,
      });
    }
  }

  await withRpcRetry("addExtraAccountMetasForExecute", () =>
    addExtraAccountMetasForExecute(
      scenario.connection,
      ix,
      scenario.transferHookProgramId,
      scenario.ataA,
      scenario.mint.publicKey,
      destination,
      scenario.investorA.publicKey,
      amount,
    ),
  );

  return ix;
}

export async function addWhitelistEntry(
  scenario: Scenario,
  tokenAccount: PublicKey = scenario.ataB,
) {
  // Administrative helper: mark destination token account as transferable.
  const entryPda = deriveWhitelistEntryPda(
    scenario.whitelistConfigPda,
    tokenAccount,
    scenario.whitelistProgramId,
  );

  const ix = new TransactionInstruction({
    programId: scenario.whitelistProgramId,
    data: Buffer.from([WHITELIST_DISCRIMINATORS.add]),
    keys: [
      { pubkey: scenario.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: scenario.whitelistConfigPda, isSigner: false, isWritable: false },
      { pubkey: entryPda, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });

  await sendTx(scenario.connection, scenario.payer, [ix]);
  return entryPda;
}

export async function removeWhitelistEntry(
  scenario: Scenario,
  tokenAccount: PublicKey = scenario.ataB,
) {
  // Administrative helper: revoke transfer eligibility for a token account.
  const entryPda = deriveWhitelistEntryPda(
    scenario.whitelistConfigPda,
    tokenAccount,
    scenario.whitelistProgramId,
  );

  const ix = new TransactionInstruction({
    programId: scenario.whitelistProgramId,
    data: Buffer.from([WHITELIST_DISCRIMINATORS.remove]),
    keys: [
      { pubkey: scenario.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: scenario.whitelistConfigPda, isSigner: false, isWritable: false },
      { pubkey: entryPda, isSigner: false, isWritable: true },
      { pubkey: tokenAccount, isSigner: false, isWritable: false },
    ],
  });

  await sendTx(scenario.connection, scenario.payer, [ix]);
  return entryPda;
}

export async function createScenario(mode: VerificationMode): Promise<Scenario> {
  // 1) Resolve network, payer, and deployed program IDs.
  const cluster = resolveCluster();
  const programIds = loadProgramIds(cluster);

  const connection = new Connection(clusterUrl(cluster), {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    wsEndpoint: process.env.SOLANA_WS_URL,
  });
  const payer = resolvePayer();
  await maybeAirdrop(connection, payer, cluster);

  const securityProgramId = new PublicKey(programIds.securityTokenProgram);
  const transferHookProgramId = new PublicKey(programIds.transferHookProgram);
  const whitelistProgramId = new PublicKey(programIds.transferWhitelistProgram);

  await ensureProgramExecutable(connection, securityProgramId);
  await ensureProgramExecutable(connection, transferHookProgramId);
  await ensureProgramExecutable(connection, whitelistProgramId);

  // 2) Create ephemeral identities and derive all PDAs needed for setup.
  const mint = Keypair.generate();
  const investorA = Keypair.generate();
  const investorB = Keypair.generate();
  const decimals = 6;

  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("mint.authority"),
      mint.publicKey.toBuffer(),
      payer.publicKey.toBuffer(),
    ],
    securityProgramId,
  );
  const [freezeAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint.freeze_authority"), mint.publicKey.toBuffer()],
    securityProgramId,
  );
  const [verificationConfigMintPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("verification_config"),
      mint.publicKey.toBuffer(),
      Buffer.from([DISCRIMINATORS.mint]),
    ],
    securityProgramId,
  );
  const [verificationConfigTransferPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("verification_config"),
      mint.publicKey.toBuffer(),
      Buffer.from([DISCRIMINATORS.transfer]),
    ],
    securityProgramId,
  );
  const [transferHookPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint.transfer_hook"), mint.publicKey.toBuffer()],
    securityProgramId,
  );
  const [accountMetasPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
    transferHookProgramId,
  );
  const [permanentDelegatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint.permanent_delegate"), mint.publicKey.toBuffer()],
    securityProgramId,
  );
  const [whitelistConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("whitelist-config"), mint.publicKey.toBuffer()],
    whitelistProgramId,
  );

  // 3) Initialize mint with metadata and transfer-hook compatible extensions.
  const initMintData = Buffer.concat([
    Buffer.from([DISCRIMINATORS.initializeMint]),
    encodeInitializeMintArgs({
      decimals,
      mintAuthority: payer.publicKey,
      freezeAuthority: freezeAuthorityPda,
      metadataPointer: {
        authority: payer.publicKey,
        metadataAddress: mint.publicKey,
      },
      metadata: {
        name: process.env.TOKEN_NAME ?? "SSTS Example",
        symbol: process.env.TOKEN_SYMBOL ?? "SSTS",
        uri: process.env.TOKEN_URI ?? "https://example.com/metadata.json",
      },
    }),
  ]);

  const initMintIx = new TransactionInstruction({
    programId: securityProgramId,
    data: initMintData,
    keys: [
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
  });
  await sendTx(connection, payer, [initMintIx], [mint]);

  // 4) Create token accounts used as sender and receiver in tests.
  const ataA = await ensureAssociatedTokenAccount(
    connection,
    payer,
    mint.publicKey,
    investorA.publicKey,
  );
  const ataB = await ensureAssociatedTokenAccount(
    connection,
    payer,
    mint.publicKey,
    investorB.publicKey,
  );

  // 5) Configure verification:
  // - Mint uses CPI mode for simplicity.
  // - Transfer mode is selected by test scenario (introspection or cpi).
  const initMintConfigData = Buffer.concat([
    Buffer.from([DISCRIMINATORS.initializeVerificationConfig]),
    encodeInitializeVerificationConfigArgs({
      instructionDiscriminator: DISCRIMINATORS.mint,
      cpiMode: true,
      programAddresses: [whitelistProgramId],
    }),
  ]);

  const initMintConfigIx = new TransactionInstruction({
    programId: securityProgramId,
    data: initMintConfigData,
    keys: [
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: verificationConfigMintPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  await sendTx(connection, payer, [initMintConfigIx]);

  const initTransferConfigData = Buffer.concat([
    Buffer.from([DISCRIMINATORS.initializeVerificationConfig]),
    encodeInitializeVerificationConfigArgs({
      instructionDiscriminator: DISCRIMINATORS.transfer,
      cpiMode: mode === "cpi",
      programAddresses: [whitelistProgramId],
    }),
  ]);

  const initTransferConfigIx = new TransactionInstruction({
    programId: securityProgramId,
    data: initTransferConfigData,
    keys: [
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      {
        pubkey: verificationConfigTransferPda,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: accountMetasPda, isSigner: false, isWritable: true },
      { pubkey: transferHookPda, isSigner: false, isWritable: false },
      { pubkey: transferHookProgramId, isSigner: false, isWritable: false },
    ],
  });
  await sendTx(connection, payer, [initTransferConfigIx]);

  // 6) Initialize whitelist storage for this mint.
  const initWhitelistIx = new TransactionInstruction({
    programId: whitelistProgramId,
    data: Buffer.from([WHITELIST_DISCRIMINATORS.initialize]),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: whitelistConfigPda, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
  await sendTx(connection, payer, [initWhitelistIx]);

  // 7) Mint initial supply to investor A for transfer assertions.
  const mintIx = new TransactionInstruction({
    programId: securityProgramId,
    data: Buffer.concat([Buffer.from([DISCRIMINATORS.mint]), u64le(1_000n)]),
    keys: [
      { pubkey: mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: verificationConfigMintPda, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: mint.publicKey, isSigner: false, isWritable: true },
      { pubkey: ataA, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: whitelistProgramId, isSigner: false, isWritable: false },
    ],
  });
  await sendTx(connection, payer, [mintIx]);

  return {
    cluster,
    mode,
    connection,
    payer,
    securityProgramId,
    transferHookProgramId,
    whitelistProgramId,
    mint,
    investorA,
    investorB,
    mintAuthorityPda,
    freezeAuthorityPda,
    verificationConfigMintPda,
    verificationConfigTransferPda,
    transferHookPda,
    accountMetasPda,
    permanentDelegatePda,
    whitelistConfigPda,
    ataA,
    ataB,
    decimals,
  };
}
