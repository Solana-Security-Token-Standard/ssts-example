//! Transfer Whitelist Verification Program
//!
//! Implements the SSTS verification interface for transfer whitelisting.
//! A transfer is approved only if the destination token account has an
//! active whitelist entry. Calls without the required whitelist accounts
//! are rejected.

use pinocchio::account_info::AccountInfo;
#[cfg(not(feature = "no-entrypoint"))]
use pinocchio::entrypoint;
use pinocchio::instruction::{Seed, Signer};
use pinocchio::program_error::ProgramError;
use pinocchio::pubkey::{find_program_address, Pubkey, PUBKEY_BYTES};
use pinocchio::sysvars::rent::Rent;
use pinocchio::sysvars::Sysvar;
use pinocchio::ProgramResult;
use pinocchio_log::log;
use pinocchio_system::instructions::CreateAccount;

const MINT_DISCRIMINATOR: u8 = 6;
const TRANSFER_DISCRIMINATOR: u8 = 12;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const CONFIG_SEED: &[u8] = b"whitelist-config";
const ENTRY_SEED: &[u8] = b"whitelist-entry";

const INIT_DISCRIMINATOR: u8 = 200;
const ADD_DISCRIMINATOR: u8 = 201;
const REMOVE_DISCRIMINATOR: u8 = 202;

const CONFIG_DISCRIMINATOR: u8 = 1;
const ENTRY_DISCRIMINATOR: u8 = 2;

#[repr(u32)]
enum TransferWhitelistError {
    InvalidMintOwner = 1,
    MintMismatch = 2,
    WhitelistEntryInactive = 3,
}

impl From<TransferWhitelistError> for ProgramError {
    fn from(error: TransferWhitelistError) -> Self {
        ProgramError::Custom(error as u32)
    }
}

#[repr(C)]
struct WhitelistConfig {
    discriminator: u8,
    admin: Pubkey,
    mint: Pubkey,
    bump: u8,
}

impl WhitelistConfig {
    const LEN: usize = 1 + PUBKEY_BYTES + PUBKEY_BYTES + 1;

    fn to_bytes(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(Self::LEN);
        data.push(self.discriminator);
        data.extend_from_slice(self.admin.as_ref());
        data.extend_from_slice(self.mint.as_ref());
        data.push(self.bump);
        data
    }

    fn try_from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut offset = 0;

        let discriminator = data[offset];
        offset += 1;
        if discriminator != CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let admin = Pubkey::from(
            <[u8; PUBKEY_BYTES]>::try_from(&data[offset..offset + PUBKEY_BYTES])
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        offset += PUBKEY_BYTES;

        let mint = Pubkey::from(
            <[u8; PUBKEY_BYTES]>::try_from(&data[offset..offset + PUBKEY_BYTES])
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        offset += PUBKEY_BYTES;

        let bump = data[offset];
        Ok(Self {
            discriminator,
            admin,
            mint,
            bump,
        })
    }
}

#[repr(C)]
struct WhitelistEntry {
    discriminator: u8,
    owner: Pubkey,
    active: u8,
    bump: u8,
}

impl WhitelistEntry {
    const LEN: usize = 1 + PUBKEY_BYTES + 1 + 1;

    fn to_bytes(&self) -> Vec<u8> {
        let mut data = Vec::with_capacity(Self::LEN);
        data.push(self.discriminator);
        data.extend_from_slice(self.owner.as_ref());
        data.push(self.active);
        data.push(self.bump);
        data
    }

    fn try_from_bytes(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut offset = 0;

        let discriminator = data[offset];
        offset += 1;
        if discriminator != ENTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }

        let owner = Pubkey::from(
            <[u8; PUBKEY_BYTES]>::try_from(&data[offset..offset + PUBKEY_BYTES])
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        offset += PUBKEY_BYTES;

        let active = data[offset];
        offset += 1;

        let bump = data[offset];
        Ok(Self {
            discriminator,
            owner,
            active,
            bump,
        })
    }
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let discriminator = *instruction_data
        .first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match discriminator {
        INIT_DISCRIMINATOR => initialize_config(program_id, accounts),
        ADD_DISCRIMINATOR => add_to_whitelist(program_id, accounts),
        REMOVE_DISCRIMINATOR => remove_from_whitelist(program_id, accounts),
        MINT_DISCRIMINATOR => Ok(()),
        TRANSFER_DISCRIMINATOR => verify_transfer(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn initialize_config(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [payer, config, mint, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable() || !config.is_writable() {
        return Err(ProgramError::InvalidArgument);
    }
    if !mint.is_owned_by(&pinocchio_token_2022::ID) {
        return Err(TransferWhitelistError::InvalidMintOwner.into());
    }

    let (expected_pda, bump) =
        find_program_address(&[CONFIG_SEED, mint.key().as_ref()], program_id);
    if expected_pda != *config.key() {
        return Err(ProgramError::InvalidSeeds);
    }

    if config.data_len() > 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(WhitelistConfig::LEN);

    let create_account = CreateAccount {
        from: payer,
        to: config,
        lamports,
        space: WhitelistConfig::LEN as u64,
        owner: program_id,
    };

    let bump_seed = [bump];
    let seeds = [
        Seed::from(CONFIG_SEED),
        Seed::from(mint.key().as_ref()),
        Seed::from(bump_seed.as_ref()),
    ];
    let signer = Signer::from(&seeds);
    create_account.invoke_signed(&[signer])?;

    let config_state = WhitelistConfig {
        discriminator: CONFIG_DISCRIMINATOR,
        admin: *payer.key(),
        mint: *mint.key(),
        bump,
    };

    let mut data = config.try_borrow_mut_data()?;
    let bytes = config_state.to_bytes();
    data[..bytes.len()].copy_from_slice(&bytes);

    log!("Whitelist config initialized");
    Ok(())
}

fn add_to_whitelist(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [admin, config, entry, token_account, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !admin.is_writable() || !entry.is_writable() {
        return Err(ProgramError::InvalidArgument);
    }

    if !config.is_owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }

    let config_state = WhitelistConfig::try_from_bytes(&config.try_borrow_data()?)?;
    if config_state.admin != *admin.key() {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_entry, bump) = find_program_address(
        &[
            ENTRY_SEED,
            config.key().as_ref(),
            token_account.key().as_ref(),
        ],
        program_id,
    );
    if expected_entry != *entry.key() {
        return Err(ProgramError::InvalidSeeds);
    }

    if entry.data_len() > 0 && !entry.is_owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }

    if entry.data_len() == 0 {
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(WhitelistEntry::LEN);
        let create_account = CreateAccount {
            from: admin,
            to: entry,
            lamports,
            space: WhitelistEntry::LEN as u64,
            owner: program_id,
        };
        let bump_seed = [bump];
        let seeds = [
            Seed::from(ENTRY_SEED),
            Seed::from(config.key().as_ref()),
            Seed::from(token_account.key().as_ref()),
            Seed::from(bump_seed.as_ref()),
        ];
        let signer = Signer::from(&seeds);
        create_account.invoke_signed(&[signer])?;
    }

    let entry_state = WhitelistEntry {
        discriminator: ENTRY_DISCRIMINATOR,
        owner: *token_account.key(),
        active: 1,
        bump,
    };

    let mut data = entry.try_borrow_mut_data()?;
    let bytes = entry_state.to_bytes();
    data[..bytes.len()].copy_from_slice(&bytes);

    log!("Whitelist entry added");
    Ok(())
}

fn remove_from_whitelist(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [admin, config, entry, token_account] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !admin.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !entry.is_writable() {
        return Err(ProgramError::InvalidArgument);
    }

    if !config.is_owned_by(program_id) || !entry.is_owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }

    let config_state = WhitelistConfig::try_from_bytes(&config.try_borrow_data()?)?;
    if config_state.admin != *admin.key() {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_entry, _bump) = find_program_address(
        &[
            ENTRY_SEED,
            config.key().as_ref(),
            token_account.key().as_ref(),
        ],
        program_id,
    );
    if expected_entry != *entry.key() {
        return Err(ProgramError::InvalidSeeds);
    }

    let mut entry_state = WhitelistEntry::try_from_bytes(&entry.try_borrow_data()?)?;
    entry_state.active = 0;

    let mut data = entry.try_borrow_mut_data()?;
    let bytes = entry_state.to_bytes();
    data[..bytes.len()].copy_from_slice(&bytes);

    log!("Whitelist entry removed");
    Ok(())
}

/// Parsed accounts for the verify_transfer instruction.
///
/// Two invocation layouts are supported. Both expose `mint` and `destination`
/// at the same semantic positions; the struct hides the positional difference.
///
/// ## SSTS Introspection path
/// Base accounts (provided by SSTS, guaranteed present via starts_with check):
///   [0] permanent_delegate_authority
///   [1] mint                          (Token-2022)
///   [2] from                          (Token-2022 source token account)
///   [3] to                            (Token-2022 destination token account)  ← destination
///   [4] transfer_hook_program
///   [5] token_program                 (Token-2022)
/// Additional accounts (appended by the client, validated by this program):
///   [6] whitelist_config              (PDA: ["whitelist-config", mint])
///   [7] whitelist_entry               (PDA: ["whitelist-entry", config, to])
///
/// ## Transfer Hook CPI path
/// Base accounts (standard SPL Transfer Hook layout, validated by Token-2022):
///   [0] from                          (Token-2022 source token account)
///   [1] mint                          (Token-2022)
///   [2] to                            (Token-2022 destination token account)  ← destination
///   [3] authority                     (transfer authority; NOT Token-2022 owned)
/// Additional accounts (resolved via ExtraAccountMetaList, appended by Token-2022):
///   [4] whitelist_config              (PDA: ["whitelist-config", mint])
///   [5] whitelist_entry               (PDA: ["whitelist-entry", config, to])
///
/// ## SSTS CPI path (NOT supported)
/// SSTS constructs the CPI call itself and passes only target_accounts
/// (instruction accounts minus verification program IDs). The whitelist PDAs
/// will never be present in that account list. Do not register this program
/// as a verifier in CPI mode.
struct VerifyTransferAccounts<'a> {
    mint: &'a AccountInfo,
    destination: &'a AccountInfo,
}

impl<'a> VerifyTransferAccounts<'a> {
    /// Parses the flat account slice into semantic names.
    ///
    /// Path detection: accounts[3] is Token-2022-owned → SSTS introspection (destination at
    /// index 3); otherwise → Transfer Hook CPI (destination at index 2). A missing entry for
    /// the resolved destination is an immediate error — there is no fallback.
    fn parse(accounts: &'a [AccountInfo]) -> Result<Self, ProgramError> {
        let [_permanent_delegate_or_from, mint, from_or_dest, dest_or_authority, ..] = accounts
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        let destination = if dest_or_authority.is_owned_by(&pinocchio_token_2022::ID) {
            dest_or_authority // SSTS introspection: accounts[3] = to
        } else {
            from_or_dest // Transfer Hook CPI: accounts[2] = to
        };
        Ok(Self { mint, destination })
    }
}

fn verify_transfer(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let VerifyTransferAccounts { mint, destination } = VerifyTransferAccounts::parse(accounts)?;

    if !mint.is_owned_by(&pinocchio_token_2022::ID) {
        return Err(TransferWhitelistError::InvalidMintOwner.into());
    }

    let (expected_config, _bump) =
        find_program_address(&[CONFIG_SEED, mint.key().as_ref()], program_id);
    let Some(config) = accounts.iter().find(|acc| acc.key() == &expected_config) else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !config.is_owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }

    let config_state = WhitelistConfig::try_from_bytes(&config.try_borrow_data()?)?;
    if config_state.mint != *mint.key() {
        return Err(TransferWhitelistError::MintMismatch.into());
    }

    let (expected_entry, _bump) = find_program_address(
        &[
            ENTRY_SEED,
            config.key().as_ref(),
            destination.key().as_ref(),
        ],
        program_id,
    );
    let Some(entry) = accounts.iter().find(|acc| acc.key() == &expected_entry) else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !entry.is_owned_by(program_id) {
        return Err(ProgramError::IllegalOwner);
    }

    let entry_state = WhitelistEntry::try_from_bytes(&entry.try_borrow_data()?)?;
    if entry_state.active == 0 {
        return Err(TransferWhitelistError::WhitelistEntryInactive.into());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pubkey(byte: u8) -> Pubkey {
        Pubkey::from([byte; PUBKEY_BYTES])
    }

    #[test]
    fn whitelist_config_roundtrip() {
        let original = WhitelistConfig {
            discriminator: CONFIG_DISCRIMINATOR,
            admin: pubkey(7),
            mint: pubkey(9),
            bump: 3,
        };

        let bytes = original.to_bytes();
        assert_eq!(bytes.len(), WhitelistConfig::LEN);

        let decoded = WhitelistConfig::try_from_bytes(&bytes).unwrap();
        assert_eq!(decoded.discriminator, CONFIG_DISCRIMINATOR);
        assert_eq!(decoded.admin, original.admin);
        assert_eq!(decoded.mint, original.mint);
        assert_eq!(decoded.bump, original.bump);
    }

    #[test]
    fn whitelist_entry_roundtrip() {
        let original = WhitelistEntry {
            discriminator: ENTRY_DISCRIMINATOR,
            owner: pubkey(11),
            active: 1,
            bump: 5,
        };

        let bytes = original.to_bytes();
        assert_eq!(bytes.len(), WhitelistEntry::LEN);

        let decoded = WhitelistEntry::try_from_bytes(&bytes).unwrap();
        assert_eq!(decoded.discriminator, ENTRY_DISCRIMINATOR);
        assert_eq!(decoded.owner, original.owner);
        assert_eq!(decoded.active, 1);
        assert_eq!(decoded.bump, original.bump);
    }

    #[test]
    fn whitelist_config_rejects_invalid_data() {
        let short = vec![CONFIG_DISCRIMINATOR; 4];
        assert!(matches!(
            WhitelistConfig::try_from_bytes(&short),
            Err(ProgramError::InvalidAccountData)
        ));

        let mut wrong_discriminator = vec![0u8; WhitelistConfig::LEN];
        wrong_discriminator[0] = 99;
        assert!(matches!(
            WhitelistConfig::try_from_bytes(&wrong_discriminator),
            Err(ProgramError::InvalidAccountData)
        ));
    }

    #[test]
    fn whitelist_entry_rejects_invalid_data() {
        let short = vec![ENTRY_DISCRIMINATOR; 3];
        assert!(matches!(
            WhitelistEntry::try_from_bytes(&short),
            Err(ProgramError::InvalidAccountData)
        ));

        let mut wrong_discriminator = vec![0u8; WhitelistEntry::LEN];
        wrong_discriminator[0] = 55;
        assert!(matches!(
            WhitelistEntry::try_from_bytes(&wrong_discriminator),
            Err(ProgramError::InvalidAccountData)
        ));
    }
}
