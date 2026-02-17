# Transfer Whitelist Verification Program

This verification program implements the SSTS verification interface and enforces a simple
whitelist for transfers **when extra whitelist accounts are provided** in the verification call.

## Instructions (Custom)
Custom admin instructions are dispatched by a 1-byte discriminator:
- `200` Initialize whitelist config
- `201` Add token account to whitelist
- `202` Remove token account from whitelist

## Verification Interface
- Transfer verification uses the **SSTS transfer discriminator (12)**.
- Mint verification (discriminator 6) is **allowed** by default.

### Transfer Contexts
This program can be called in two contexts:
- **SSTS transfer verification call (introspection path)**:
  include whitelist `config` and `entry` accounts in the verification instruction; whitelist is enforced.
- **Token-2022 Transfer Hook CPI call (direct transfer path)**:
  include whitelist `config` and `entry` accounts in the transfer instruction account list; whitelist is enforced.

If the required whitelist context accounts are missing or malformed, transfer verification fails.

For production, make sure the transfer-hook extra account meta list includes all whitelist
accounts required by your verification policy.

## Build
```bash
cargo build-sbf
```

## Deploy
```bash
solana program deploy target/deploy/transfer_whitelist.so --program-id target/deploy/transfer_whitelist-keypair.json
```

After deployment, update `config/program-ids.json` with the program ID.
