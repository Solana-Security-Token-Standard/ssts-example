//! Transfer Whitelist Verification Program
//!
//! This program implements the Security Token verification interface.
//! It enforces a simple whitelist for transfers when extra whitelist
//! accounts are provided in the transfer verification call. Calls
//! without that context are rejected with NotEnoughAccountKeys.

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
        let discriminator = data[0];
        if discriminator != CONFIG_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let admin_bytes: [u8; PUBKEY_BYTES] = data[1..1 + PUBKEY_BYTES]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        let admin = Pubkey::from(admin_bytes);
        let mint_bytes: [u8; PUBKEY_BYTES] = data
            [1 + PUBKEY_BYTES..1 + PUBKEY_BYTES + PUBKEY_BYTES]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        let mint = Pubkey::from(mint_bytes);
        let bump = data[Self::LEN - 1];
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
        let discriminator = data[0];
        if discriminator != ENTRY_DISCRIMINATOR {
            return Err(ProgramError::InvalidAccountData);
        }
        let owner_bytes: [u8; PUBKEY_BYTES] = data[1..1 + PUBKEY_BYTES]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?;
        let owner = Pubkey::from(owner_bytes);
        let active = data[1 + PUBKEY_BYTES];
        let bump = data[Self::LEN - 1];
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
        return Err(ProgramError::MissingRequiredSignature);
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
        return Err(ProgramError::MissingRequiredSignature);
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

fn verify_transfer(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    // Supported call layouts:
    // 1) SSTS introspection verification call
    // 2) Transfer Hook CPI call
    //
    // The exact account order may differ between those paths, so we resolve
    // required context accounts by PDA instead of relying on fixed positions.
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }

    let Some(mint) = accounts.get(1) else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
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

    // Destination account index differs by invocation layout:
    // - SSTS introspection: index 3
    // - Transfer Hook CPI: index 2
    let destination_candidates = [accounts.get(3), accounts.get(2)];
    let mut entry: Option<&AccountInfo> = None;

    for destination in destination_candidates.into_iter().flatten() {
        let (expected_entry, _bump) = find_program_address(
            &[
                ENTRY_SEED,
                config.key().as_ref(),
                destination.key().as_ref(),
            ],
            program_id,
        );
        if let Some(found) = accounts.iter().find(|acc| acc.key() == &expected_entry) {
            entry = Some(found);
            break;
        }
    }

    let Some(entry) = entry else {
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
