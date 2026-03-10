import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  address,
  type Rpc,
  type SolanaRpcApi,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  lamports,
  sendTransactionWithoutConfirmingFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
  type Signature,
} from "@solana/kit";
import * as sstsClientModule from "@ssts-org/client";

// Supported targets for this setup script. Keep this aligned with config/program-ids.json.
type Cluster = "localnet" | "devnet" | "testnet" | "mainnet";

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

type SetupOutput = {
  createdAt: string;
  cluster: Cluster;
  payer: string;
  mint: string;
  programIds: ProgramIdsResolved;
  pdas: {
    mintAuthority: string;
    freezeAuthority: string;
    permanentDelegate: string;
    transferHook: string;
    accountMetas: string;
    verificationConfigMint: string;
    verificationConfigTransfer: string;
    whitelistConfig: string;
  };
  recipient: {
    owner: string | null;
    tokenAccount: string | null;
  };
  initialMintAmount: string;
  whitelistTokenAccounts: string[];
  signatures: {
    initializeMint: string | null;
    initializeMintVerificationConfig: string | null;
    initializeTransferVerificationConfig: string | null;
    initializeWhitelistConfig: string | null;
    mintInitialAmount: string | null;
    whitelistAdds: Array<{
      tokenAccount: string;
      whitelistEntryPda: string;
      signature: string;
    }>;
  };
  skipped: string[];
};

const INSTRUCTION_DISCRIMINATORS = {
  mint: 6,
  transfer: 12,
} as const;

const WHITELIST_DISCRIMINATORS = {
  initialize: 200,
  add: 201,
  remove: 202,
} as const;

// Well-known addresses used by the setup flow.
const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
const TOKEN_2022_PROGRAM_ADDRESS = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
const INSTRUCTIONS_SYSVAR_ADDRESS = address(
  "Sysvar1nstructions1111111111111111111111111",
);

type KitInstruction = Instruction & {
  readonly accounts: NonNullable<Instruction["accounts"]>;
  readonly data: Uint8Array;
};

type KitInstructionBuilder = (
  input: Record<string, unknown>,
  config?: { programAddress?: string },
) => KitInstruction;

type SolanaRpcClient = Rpc<SolanaRpcApi>;

type AccountInfoValue = Readonly<{
  executable: boolean;
}> | null;

// Published generated client package is CommonJS-shaped at runtime under tsx.
// This helper normalizes both ESM-style and CJS-style exports.
function resolveClientModule(moduleObject: unknown): Record<string, unknown> {
  const moduleRecord = moduleObject as {
    default?: Record<string, unknown>;
  };
  return moduleRecord.default ?? (moduleObject as Record<string, unknown>);
}

// Fail fast if a generated client export is missing. This catches client/version drift early.
function requireInstructionBuilder(
  moduleObject: unknown,
  exportName: string,
): KitInstructionBuilder {
  const resolved = resolveClientModule(moduleObject);
  const candidate = resolved[exportName];
  if (typeof candidate !== "function") {
    throw new Error(`Generated client export not found: ${exportName}`);
  }
  return candidate as KitInstructionBuilder;
}

// Core SSTS generated instruction builders used by this script.
const getInitializeMintInstruction = requireInstructionBuilder(
  sstsClientModule,
  "getInitializeMintInstruction",
);

const getInitializeVerificationConfigInstruction = requireInstructionBuilder(
  sstsClientModule,
  "getInitializeVerificationConfigInstruction",
);

const getMintInstruction = requireInstructionBuilder(
  sstsClientModule,
  "getMintInstruction",
);

const CLI_FLAG_TO_ENV: Record<string, string> = {
  "--cluster": "CLUSTER",
  "--token-root": "TOKEN_ROOT",
  "--solana-keypair": "SOLANA_KEYPAIR",
  "--security-token-program-id": "SECURITY_TOKEN_PROGRAM_ID",
  "--transfer-hook-program-id": "TRANSFER_HOOK_PROGRAM_ID",
  "--transfer-whitelist-program-id": "TRANSFER_WHITELIST_PROGRAM_ID",
  "--existing-mint": "EXISTING_MINT",
  "--token-name": "TOKEN_NAME",
  "--token-symbol": "TOKEN_SYMBOL",
  "--token-uri": "TOKEN_URI",
  "--token-decimals": "TOKEN_DECIMALS",
  "--initial-mint-amount": "INITIAL_MINT_AMOUNT",
  "--initial-recipient-owner": "INITIAL_RECIPIENT_OWNER",
  "--auto-whitelist-initial-recipient": "AUTO_WHITELIST_INITIAL_RECIPIENT",
  "--initial-whitelist-token-accounts": "INITIAL_WHITELIST_TOKEN_ACCOUNTS",
  "--auto-airdrop": "AUTO_AIRDROP",
  "--min-payer-balance-sol": "MIN_PAYER_BALANCE_SOL",
  "--airdrop-sol": "AIRDROP_SOL",
  "--issuer-state-path": "ISSUER_STATE_PATH",
};

function printHelp(): void {
  console.log(`SSTS issuer setup

Usage:
  node --import tsx scripts/issuer-setup.ts [options]

Options:
  -h, --help
      Show this help text and exit.
  --cluster <value>
      localnet | devnet | testnet | mainnet
  --token-root <path>
      Project root containing config/program-ids.json.
  --solana-keypair <path>
      Path to payer keypair JSON file.
  --security-token-program-id <pubkey>
  --transfer-hook-program-id <pubkey>
  --transfer-whitelist-program-id <pubkey>
      Optional program-id overrides.
  --existing-mint <pubkey>
      Use existing mint instead of creating a new one.
  --token-name <string>
  --token-symbol <string>
  --token-uri <string>
      Metadata for new mint creation. URI can be empty.
  --token-decimals <u8>
  --initial-mint-amount <u64>
  --initial-recipient-owner <pubkey>
  --auto-whitelist-initial-recipient <bool>
      true/false/1/0
  --initial-whitelist-token-accounts <pubkey,pubkey,...>
  --auto-airdrop <bool>
  --min-payer-balance-sol <number>
  --airdrop-sol <number>
  --issuer-state-path <path>

Notes:
  - CLI options override environment variables.
  - scripts/issuer-setup.sh loads .env first, then forwards CLI options here.
  - Program IDs default to config/program-ids.json for selected cluster.
`);
}

function applyCliOverrides(argv: string[]): void {
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === "-h" || token === "--help") {
      printHelp();
      process.exit(0);
    }

    if (!token.startsWith("--")) {
      throw new Error(
        `Unexpected argument: ${token}. Use --help to see supported options.`,
      );
    }

    const equalsIndex = token.indexOf("=");
    const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
    const envName = CLI_FLAG_TO_ENV[flag];
    if (!envName) {
      throw new Error(`Unknown option: ${flag}. Use --help for supported options.`);
    }

    let value: string;
    if (equalsIndex >= 0) {
      value = token.slice(equalsIndex + 1);
    } else {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${flag}.`);
      }
      value = argv[index]!;
    }

    process.env[envName] = value;
    index += 1;
  }
}

// CLUSTER defaults to devnet to make first run easy.
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

function clusterUrl(cluster: Cluster): string {
  const override = process.env.SOLANA_RPC_URL?.trim();
  if (override) {
    return override;
  }
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  if (cluster === "mainnet") {
    return "https://api.mainnet-beta.solana.com";
  }
  return `https://api.${cluster}.solana.com`;
}

// Reads a Solana CLI style keypair file (JSON array of 64 bytes).
function loadKeypairBytes(filePath: string): Uint8Array {
  const raw = fs.readFileSync(filePath, "utf-8");
  return Uint8Array.from(JSON.parse(raw) as number[]);
}

async function resolvePayerSigner(): Promise<KeyPairSigner> {
  const explicit = process.env.SOLANA_KEYPAIR;
  const defaultPath = path.join(os.homedir(), ".config/solana/id.json");
  const signerBytes = loadKeypairBytes(explicit ?? defaultPath);
  return createKeyPairSignerFromBytes(signerBytes);
}

// Generic env parsing helpers with strict validation so setup fails loudly on bad config.
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "y") {
    return true;
  }
  if (
    value === "0" ||
    value === "false" ||
    value === "no" ||
    value === "n"
  ) {
    return false;
  }
  throw new Error(`Invalid boolean value for ${name}: ${raw}`);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value for ${name}: ${raw}`);
  }
  return value;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  try {
    return BigInt(raw.trim());
  } catch {
    throw new Error(`Invalid bigint value for ${name}: ${raw}`);
  }
}

function envCsv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// Program IDs can come from env or config file.
// Precedence: explicit env override -> config/program-ids.json.
function readProgramIdsFromConfig(
  cluster: Cluster,
  tokenRoot: string,
): ProgramIdsResolved {
  const configPath = path.resolve(tokenRoot, "config/program-ids.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<Cluster, ProgramIds>;
  const entry = parsed[cluster];

  const fromEnv: ProgramIds = {
    securityTokenProgram: process.env.SECURITY_TOKEN_PROGRAM_ID ?? null,
    transferHookProgram: process.env.TRANSFER_HOOK_PROGRAM_ID ?? null,
    transferWhitelistProgram: process.env.TRANSFER_WHITELIST_PROGRAM_ID ?? null,
  };

  const securityTokenProgram =
    fromEnv.securityTokenProgram ?? entry?.securityTokenProgram ?? null;
  const transferHookProgram =
    fromEnv.transferHookProgram ?? entry?.transferHookProgram ?? null;
  const transferWhitelistProgram =
    fromEnv.transferWhitelistProgram ?? entry?.transferWhitelistProgram ?? null;

  if (
    !securityTokenProgram ||
    !transferHookProgram ||
    !transferWhitelistProgram
  ) {
    throw new Error(
      `Missing one or more program IDs for ${cluster}. Update ${configPath}.`,
    );
  }

  return {
    securityTokenProgram,
    transferHookProgram,
    transferWhitelistProgram,
  };
}

function toAddress(value: string): Address {
  return address(value);
}

function stringifyWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_, candidate) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccountInfoOrNull(
  rpc: SolanaRpcClient,
  accountAddress: Address,
): Promise<AccountInfoValue> {
  const response = await rpc
    .getAccountInfo(accountAddress, {
      commitment: "confirmed",
      encoding: "base64",
    })
    .send();
  return response.value as AccountInfoValue;
}

async function waitForSignatureConfirmation(
  rpc: SolanaRpcClient,
  signature: Signature,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .send();
    const status = response.value[0];
    if (status) {
      if (status.err) {
        throw new Error(
          `Transaction ${signature} failed: ${stringifyWithBigInts(status.err)}`,
        );
      }
      if (
        status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized"
      ) {
        return;
      }
    }
    await sleep(500);
  }

  throw new Error(`Timed out waiting for confirmation: ${signature}`);
}

type SendTransactionWithoutConfirming = ReturnType<
  typeof sendTransactionWithoutConfirmingFactory
>;

// Sends a signed transaction and waits until confirmed commitment using RPC polling.
async function sendTx(
  rpc: SolanaRpcClient,
  sendTransaction: SendTransactionWithoutConfirming,
  payerSigner: KeyPairSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();

  const transactionMessageWithPayer = setTransactionMessageFeePayerSigner(
    payerSigner,
    createTransactionMessage({ version: "legacy" }),
  );
  const transactionMessageWithLifetime = setTransactionMessageLifetimeUsingBlockhash(
    latestBlockhash,
    transactionMessageWithPayer,
  );

  const transactionMessage = appendTransactionMessageInstructions(
    instructions,
    transactionMessageWithLifetime,
  );

  const signedTransaction =
    await signTransactionMessageWithSigners(transactionMessage);
  const signature = getSignatureFromTransaction(signedTransaction);

  await sendTransaction(signedTransaction, { commitment: "confirmed" });
  await waitForSignatureConfirmation(rpc, signature, 120_000);
  return signature;
}

// Sanity check: fail before setup if a provided program id does not exist or is not executable.
async function ensureProgramExecutable(
  rpc: SolanaRpcClient,
  programAddress: Address,
): Promise<void> {
  const info = await getAccountInfoOrNull(rpc, programAddress);
  if (!info) {
    throw new Error(`Program account not found on chain: ${programAddress}`);
  }
  if (!info.executable) {
    throw new Error(`Account is not executable: ${programAddress}`);
  }
}

function createAssociatedTokenAccountInstruction(
  payerAddress: Address,
  associatedTokenAddress: Address,
  ownerAddress: Address,
  mintAddress: Address,
): Instruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    data: new Uint8Array(),
    accounts: [
      { address: payerAddress, role: AccountRole.WRITABLE_SIGNER },
      { address: associatedTokenAddress, role: AccountRole.WRITABLE },
      { address: ownerAddress, role: AccountRole.READONLY },
      { address: mintAddress, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
}

function createInitializeWhitelistInstruction(
  payerAddress: Address,
  whitelistConfigAddress: Address,
  mintAddress: Address,
  whitelistProgramAddress: Address,
): Instruction {
  return {
    programAddress: whitelistProgramAddress,
    data: new Uint8Array([WHITELIST_DISCRIMINATORS.initialize]),
    accounts: [
      { address: payerAddress, role: AccountRole.WRITABLE_SIGNER },
      { address: whitelistConfigAddress, role: AccountRole.WRITABLE },
      { address: mintAddress, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
}

function createAddWhitelistInstruction(
  payerAddress: Address,
  whitelistConfigAddress: Address,
  whitelistEntryAddress: Address,
  tokenAccountAddress: Address,
  whitelistProgramAddress: Address,
): Instruction {
  return {
    programAddress: whitelistProgramAddress,
    data: new Uint8Array([WHITELIST_DISCRIMINATORS.add]),
    accounts: [
      { address: payerAddress, role: AccountRole.WRITABLE_SIGNER },
      { address: whitelistConfigAddress, role: AccountRole.READONLY },
      { address: whitelistEntryAddress, role: AccountRole.WRITABLE },
      { address: tokenAccountAddress, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ],
  };
}

function appendExtraAccounts(
  instruction: Instruction,
  extraAccounts: NonNullable<Instruction["accounts"]>,
): Instruction {
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...extraAccounts],
  };
}

async function deriveAssociatedTokenAddress(
  ownerAddress: Address,
  mintAddress: Address,
): Promise<Address> {
  const addressEncoder = getAddressEncoder();
  const [associatedTokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      addressEncoder.encode(ownerAddress),
      addressEncoder.encode(TOKEN_2022_PROGRAM_ADDRESS),
      addressEncoder.encode(mintAddress),
    ],
  });
  return associatedTokenAddress;
}

// Creates ATA only when missing, so reruns are idempotent.
async function ensureAssociatedTokenAccount(
  rpc: SolanaRpcClient,
  sendTransaction: SendTransactionWithoutConfirming,
  payerSigner: KeyPairSigner,
  mintAddress: Address,
  ownerAddress: Address,
): Promise<Address> {
  const associatedTokenAddress = await deriveAssociatedTokenAddress(
    ownerAddress,
    mintAddress,
  );
  const info = await getAccountInfoOrNull(rpc, associatedTokenAddress);
  if (!info) {
    const instruction = createAssociatedTokenAccountInstruction(
      payerSigner.address,
      associatedTokenAddress,
      ownerAddress,
      mintAddress,
    );
    await sendTx(rpc, sendTransaction, payerSigner, [instruction]);
  }
  return associatedTokenAddress;
}

// Keeps payer funded on devnet/localnet. Never attempts airdrop on testnet/mainnet.
async function maybeAirdrop(
  rpc: SolanaRpcClient,
  payerAddress: Address,
  cluster: Cluster,
  minimumBalanceSol: number,
  airdropSol: number,
): Promise<void> {
  if (cluster !== "devnet" && cluster !== "localnet") {
    return;
  }

  const minLamports = BigInt(Math.floor(minimumBalanceSol * 1e9));
  const airdropLamports = BigInt(Math.floor(airdropSol * 1e9));

  const balanceResponse = await rpc
    .getBalance(payerAddress, { commitment: "confirmed" })
    .send();
  if (balanceResponse.value >= minLamports) {
    return;
  }

  const signature = await rpc
    .requestAirdrop(payerAddress, lamports(airdropLamports), {
      commitment: "confirmed",
    })
    .send();
  await waitForSignatureConfirmation(rpc, signature, 120_000);
}

// Avoid duplicate whitelist additions when values are repeated across env/default sources.
function uniqueAddresses(values: Address[]): Address[] {
  const seen = new Set<string>();
  const output: Address[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

async function main(): Promise<void> {
  applyCliOverrides(process.argv.slice(2));

  // Resolve runtime location first so the script can be moved/copied as a template.
  const cluster = resolveCluster();
  const scriptPath = fileURLToPath(import.meta.url);
  const tokenRoot = process.env.TOKEN_ROOT
    ? path.resolve(process.env.TOKEN_ROOT)
    : path.resolve(path.dirname(scriptPath), "..");
  const programIds = readProgramIdsFromConfig(cluster, tokenRoot);

  const rpc = createSolanaRpc(clusterUrl(cluster));
  const sendTransaction = sendTransactionWithoutConfirmingFactory({ rpc });
  const payerSigner = await resolvePayerSigner();

  // Optional convenience for first-time devnet/localnet users.
  if (envBool("AUTO_AIRDROP", true)) {
    await maybeAirdrop(
      rpc,
      payerSigner.address,
      cluster,
      envNumber("MIN_PAYER_BALANCE_SOL", 0.5),
      envNumber("AIRDROP_SOL", 1),
    );
  }

  const securityProgramId = toAddress(programIds.securityTokenProgram);
  const transferHookProgramId = toAddress(programIds.transferHookProgram);
  const whitelistProgramId = toAddress(programIds.transferWhitelistProgram);

  // Fail now if cluster/program-id wiring is wrong.
  await ensureProgramExecutable(rpc, securityProgramId);
  await ensureProgramExecutable(rpc, transferHookProgramId);
  await ensureProgramExecutable(rpc, whitelistProgramId);

  // EXISTING_MINT lets issuers attach to an existing mint instead of creating a new one.
  const existingMintRaw = process.env.EXISTING_MINT?.trim();
  const mintSigner = existingMintRaw ? null : await generateKeyPairSigner();
  const mintAddress = existingMintRaw
    ? toAddress(existingMintRaw)
    : mintSigner!.address;

  const addressEncoder = getAddressEncoder();
  const encodeAddress = (input: Address) => addressEncoder.encode(input);

  // Derive all PDAs once and reuse them across setup steps.
  // Seeds must stay aligned with core SSTS + whitelist program implementations.
  const [mintAuthorityPda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: ["mint.authority", encodeAddress(mintAddress), encodeAddress(payerSigner.address)],
  });
  const [freezeAuthorityPda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: ["mint.freeze_authority", encodeAddress(mintAddress)],
  });
  const [permanentDelegatePda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: ["mint.permanent_delegate", encodeAddress(mintAddress)],
  });
  const [transferHookPda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: ["mint.transfer_hook", encodeAddress(mintAddress)],
  });
  const [accountMetasPda] = await getProgramDerivedAddress({
    programAddress: transferHookProgramId,
    seeds: ["extra-account-metas", encodeAddress(mintAddress)],
  });
  const [verificationConfigMintPda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: [
      "verification_config",
      encodeAddress(mintAddress),
      new Uint8Array([INSTRUCTION_DISCRIMINATORS.mint]),
    ],
  });
  const [verificationConfigTransferPda] = await getProgramDerivedAddress({
    programAddress: securityProgramId,
    seeds: [
      "verification_config",
      encodeAddress(mintAddress),
      new Uint8Array([INSTRUCTION_DISCRIMINATORS.transfer]),
    ],
  });
  const [whitelistConfigPda] = await getProgramDerivedAddress({
    programAddress: whitelistProgramId,
    seeds: ["whitelist-config", encodeAddress(mintAddress)],
  });

  // Token-2022 decimals byte range.
  const decimals = envNumber("TOKEN_DECIMALS", 6);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("TOKEN_DECIMALS must be an integer in range [0, 255].");
  }

  const output: SetupOutput = {
    createdAt: new Date().toISOString(),
    cluster,
    payer: payerSigner.address,
    mint: mintAddress,
    programIds,
    pdas: {
      mintAuthority: mintAuthorityPda,
      freezeAuthority: freezeAuthorityPda,
      permanentDelegate: permanentDelegatePda,
      transferHook: transferHookPda,
      accountMetas: accountMetasPda,
      verificationConfigMint: verificationConfigMintPda,
      verificationConfigTransfer: verificationConfigTransferPda,
      whitelistConfig: whitelistConfigPda,
    },
    recipient: {
      owner: null,
      tokenAccount: null,
    },
    initialMintAmount: "0",
    whitelistTokenAccounts: [],
    signatures: {
      initializeMint: null,
      initializeMintVerificationConfig: null,
      initializeTransferVerificationConfig: null,
      initializeWhitelistConfig: null,
      mintInitialAmount: null,
      whitelistAdds: [],
    },
    skipped: [],
  };

  // 1) Initialize mint if it does not exist.
  // If mint already exists, record skip and continue with the rest of setup.
  const mintInfo = await getAccountInfoOrNull(rpc, mintAddress);
  if (!mintInfo) {
    if (!mintSigner) {
      throw new Error(
        `EXISTING_MINT is set but account was not found: ${mintAddress}`,
      );
    }

    const metadataName = process.env.TOKEN_NAME ?? "SSTS Example";
    const metadataSymbol = process.env.TOKEN_SYMBOL ?? "SSTS";
    // URI is optional. Empty string is valid when off-chain metadata is not used yet.
    const metadataUri = process.env.TOKEN_URI ?? "";

    // Build instruction via generated client to avoid hand-encoding SSTS args.
    const initMintIx = getInitializeMintInstruction(
      {
        mint: mintSigner,
        authority: mintAuthorityPda,
        payer: payerSigner,
        initializeMintArgs: {
          ixMint: {
            decimals,
            mintAuthority: payerSigner.address,
            freezeAuthority: freezeAuthorityPda,
          },
          ixMetadataPointer: {
            authority: payerSigner.address,
            metadataAddress: mintAddress,
          },
          ixMetadata: {
            name: metadataName,
            symbol: metadataSymbol,
            uri: metadataUri,
            additionalMetadata: new Uint8Array(),
          },
          ixScaledUiAmount: null,
        },
      },
      { programAddress: securityProgramId },
    );

    output.signatures.initializeMint = await sendTx(
      rpc,
      sendTransaction,
      payerSigner,
      [initMintIx],
    );
  } else {
    output.skipped.push("initializeMint");
  }

  // 2) Configure mint verification (instruction discriminator: mint) in CPI mode.
  // CPI mode means SSTS invokes configured verification programs internally.
  const verificationMintInfo = await getAccountInfoOrNull(rpc, verificationConfigMintPda);
  if (!verificationMintInfo) {
    const initMintConfigIx = getInitializeVerificationConfigInstruction(
      {
        mint: mintAddress,
        verificationConfigOrMintAuthority: mintAuthorityPda,
        instructionsSysvarOrCreator: payerSigner.address,
        payer: payerSigner,
        mintAccount: mintAddress,
        configAccount: verificationConfigMintPda,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        accountMetasPda,
        transferHookPda,
        transferHookProgram: transferHookProgramId,
        initializeVerificationConfigArgs: {
          instructionDiscriminator: INSTRUCTION_DISCRIMINATORS.mint,
          cpiMode: true,
          programAddresses: [whitelistProgramId],
        },
      },
      { programAddress: securityProgramId },
    );

    output.signatures.initializeMintVerificationConfig = await sendTx(
      rpc,
      sendTransaction,
      payerSigner,
      [initMintConfigIx],
    );
  } else {
    output.skipped.push("initializeMintVerificationConfig");
  }

  // 3) Configure transfer verification (instruction discriminator: transfer) in introspection mode.
  // Introspection mode expects a preceding verification instruction in the same transaction.
  const verificationTransferInfo = await getAccountInfoOrNull(
    rpc,
    verificationConfigTransferPda,
  );
  if (!verificationTransferInfo) {
    const initTransferConfigIx = getInitializeVerificationConfigInstruction(
      {
        mint: mintAddress,
        verificationConfigOrMintAuthority: mintAuthorityPda,
        instructionsSysvarOrCreator: payerSigner.address,
        payer: payerSigner,
        mintAccount: mintAddress,
        configAccount: verificationConfigTransferPda,
        systemProgram: SYSTEM_PROGRAM_ADDRESS,
        accountMetasPda,
        transferHookPda,
        transferHookProgram: transferHookProgramId,
        initializeVerificationConfigArgs: {
          instructionDiscriminator: INSTRUCTION_DISCRIMINATORS.transfer,
          cpiMode: false,
          programAddresses: [whitelistProgramId],
        },
      },
      { programAddress: securityProgramId },
    );

    output.signatures.initializeTransferVerificationConfig = await sendTx(
      rpc,
      sendTransaction,
      payerSigner,
      [initTransferConfigIx],
    );
  } else {
    output.skipped.push("initializeTransferVerificationConfig");
  }

  // 4) Initialize whitelist config account for this mint.
  const whitelistInfo = await getAccountInfoOrNull(rpc, whitelistConfigPda);
  if (!whitelistInfo) {
    const initWhitelistIx = createInitializeWhitelistInstruction(
      payerSigner.address,
      whitelistConfigPda,
      mintAddress,
      whitelistProgramId,
    );

    output.signatures.initializeWhitelistConfig = await sendTx(
      rpc,
      sendTransaction,
      payerSigner,
      [initWhitelistIx],
    );
  } else {
    output.skipped.push("initializeWhitelistConfig");
  }

  // Optional initial mint for demos/e2e bootstrap.
  const initialMintAmount = envBigInt("INITIAL_MINT_AMOUNT", 0n);
  const maxU64 = (1n << 64n) - 1n;
  if (initialMintAmount < 0n || initialMintAmount > maxU64) {
    throw new Error("INITIAL_MINT_AMOUNT must be an unsigned 64-bit integer.");
  }

  const recipientOwner = toAddress(
    process.env.INITIAL_RECIPIENT_OWNER ?? payerSigner.address,
  );

  // Recipient ATA is needed when minting initial supply or auto-whitelisting recipient.
  let recipientTokenAccount: Address | null = null;
  if (initialMintAmount > 0n || envBool("AUTO_WHITELIST_INITIAL_RECIPIENT", true)) {
    recipientTokenAccount = await ensureAssociatedTokenAccount(
      rpc,
      sendTransaction,
      payerSigner,
      mintAddress,
      recipientOwner,
    );
    output.recipient.owner = recipientOwner;
    output.recipient.tokenAccount = recipientTokenAccount;
  }

  if (initialMintAmount > 0n) {
    if (!recipientTokenAccount) {
      throw new Error("Recipient token account not available.");
    }

    // Mint verification is configured in CPI mode, so include verification program account
    // after the generated core instruction accounts.
    const mintIx = appendExtraAccounts(
      getMintInstruction(
        {
          mint: mintAddress,
          verificationConfig: verificationConfigMintPda,
          instructionsSysvar: INSTRUCTIONS_SYSVAR_ADDRESS,
          mintAuthority: mintAuthorityPda,
          mintAccount: mintAddress,
          destination: recipientTokenAccount,
          tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
          amount: initialMintAmount,
        },
        { programAddress: securityProgramId },
      ),
      [{ address: whitelistProgramId, role: AccountRole.READONLY }],
    );

    output.signatures.mintInitialAmount = await sendTx(
      rpc,
      sendTransaction,
      payerSigner,
      [mintIx],
    );
    output.initialMintAmount = initialMintAmount.toString();
  }

  // Additional bootstrap whitelist addresses can be passed via env.
  // This plus recipient auto-whitelist makes setup rerunnable for demos/tests.
  const whitelistAccounts = envCsv("INITIAL_WHITELIST_TOKEN_ACCOUNTS").map(toAddress);
  if (
    recipientTokenAccount &&
    envBool("AUTO_WHITELIST_INITIAL_RECIPIENT", true)
  ) {
    whitelistAccounts.push(recipientTokenAccount);
  }

  for (const tokenAccount of uniqueAddresses(whitelistAccounts)) {
    const [whitelistEntryPda] = await getProgramDerivedAddress({
      programAddress: whitelistProgramId,
      seeds: [
        "whitelist-entry",
        encodeAddress(whitelistConfigPda),
        encodeAddress(tokenAccount),
      ],
    });

    const existingEntry = await getAccountInfoOrNull(rpc, whitelistEntryPda);
    if (existingEntry) {
      // Keep output deterministic on reruns: record skip and continue.
      output.skipped.push(`whitelistAdd:${tokenAccount}`);
      output.whitelistTokenAccounts.push(tokenAccount);
      continue;
    }

    const addWhitelistIx = createAddWhitelistInstruction(
      payerSigner.address,
      whitelistConfigPda,
      whitelistEntryPda,
      tokenAccount,
      whitelistProgramId,
    );

    const signature = await sendTx(rpc, sendTransaction, payerSigner, [addWhitelistIx]);
    output.whitelistTokenAccounts.push(tokenAccount);
    output.signatures.whitelistAdds.push({
      tokenAccount,
      whitelistEntryPda,
      signature,
    });
  }

  // Persist setup artifact so tests/scripts can reuse concrete addresses and signatures.
  const defaultOutputPath = path.resolve(
    tokenRoot,
    "config",
    `issuer-state-${cluster}.json`,
  );
  const outputPath = process.env.ISSUER_STATE_PATH
    ? path.resolve(process.env.ISSUER_STATE_PATH)
    : defaultOutputPath;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log("Issuer setup complete.");
  console.log(`Mint: ${output.mint}`);
  console.log(`Whitelist Config: ${output.pdas.whitelistConfig}`);
  console.log(`State artifact: ${outputPath}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Issuer setup failed: ${message}`);
  process.exit(1);
});
