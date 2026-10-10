//! Host instruction/constraint tests. These execute Anchor's generated dispatch
//! and account validation, not an SBF VM. Full validator/SBF tests are a release gate.
use super::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program_error::ProgramError,
    program_pack::Pack,
    program_stubs::{set_syscall_stubs, SyscallStubs},
    system_instruction::SystemInstruction,
};
use anchor_lang::{AccountSerialize, InstructionData};
use anchor_spl::token::spl_token::state::{Account as SplAccount, AccountState, Mint as SplMint};
use std::sync::Mutex;

static STUB_LOCK: Mutex<()> = Mutex::new(());

/// A deliberately limited host harness: real SPL TransferChecked processing and
/// checked native SOL transfer, with PDA signer derivation. No account creation,
/// SBF metering, transaction rollback, rent-state checks or validator semantics.
struct TransferStubs;
impl SyscallStubs for TransferStubs {
    fn sol_get_clock_sysvar(&self, pointer: *mut u8) -> u64 {
        // Runtime supplies a writable Clock-sized buffer to this documented stub.
        unsafe {
            std::ptr::write(
                pointer.cast::<Clock>(),
                Clock {
                    slot: 100,
                    ..Clock::default()
                },
            );
        }
        0
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        signers: &[&[&[u8]]],
    ) -> anchor_lang::solana_program::entrypoint::ProgramResult {
        let pdas = signers
            .iter()
            .map(|seeds| Pubkey::create_program_address(seeds, &crate::ID))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| ProgramError::InvalidSeeds)?;
        let mut inner = Vec::new();
        for meta in &ix.accounts {
            let mut info = infos
                .iter()
                .find(|a| a.key == &meta.pubkey)
                .ok_or(ProgramError::NotEnoughAccountKeys)?
                .clone();
            if meta.is_writable && !info.is_writable {
                return Err(ProgramError::InvalidAccountData);
            }
            if pdas.contains(info.key) {
                info.is_signer = true;
            }
            if meta.is_signer && !info.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            inner.push(info);
        }
        if ix.program_id == token::ID {
            return token::spl_token::processor::Processor::process(&token::ID, &inner, &ix.data);
        }
        if ix.program_id == system_program::ID {
            match bincode::deserialize::<SystemInstruction>(&ix.data)
                .map_err(|_| ProgramError::InvalidInstructionData)?
            {
                SystemInstruction::Transfer { lamports } => {
                    if inner.len() != 2
                        || inner[0].owner != &system_program::ID
                        || !inner[0].data_is_empty()
                        || !inner[0].is_signer
                    {
                        return Err(ProgramError::InvalidAccountData);
                    }
                    let remaining = inner[0]
                        .lamports()
                        .checked_sub(lamports)
                        .ok_or(ProgramError::InsufficientFunds)?;
                    let received = inner[1]
                        .lamports()
                        .checked_add(lamports)
                        .ok_or(ProgramError::ArithmeticOverflow)?;
                    **inner[0].try_borrow_mut_lamports()? = remaining;
                    **inner[1].try_borrow_mut_lamports()? = received;
                    return Ok(());
                }
                _ => return Err(ProgramError::InvalidInstructionData),
            }
        }
        Err(ProgramError::IncorrectProgramId)
    }
}

struct RestoreStubs(Option<Box<dyn SyscallStubs>>);
impl Drop for RestoreStubs {
    fn drop(&mut self) {
        if let Some(previous) = self.0.take() {
            set_syscall_stubs(previous);
        }
    }
}

fn packed<T: Pack>(value: T) -> Vec<u8> {
    let mut data = vec![0u8; T::LEN];
    T::pack(value, &mut data).unwrap();
    data
}

fn trade_fixture() -> Vec<AccountInfo<'static>> {
    let (key, pool) = fixture_pool(ACTIVE);
    let trader = Pubkey::new_unique();
    let vault = Pubkey::find_program_address(&[b"token", key.as_ref()], &crate::ID).0;
    let reserve = Pubkey::find_program_address(&[b"reserve", key.as_ref()], &crate::ID).0;
    let fees = Pubkey::find_program_address(&[b"fees", key.as_ref()], &crate::ID).0;
    let token_state = |owner, amount| SplAccount {
        mint: pool.mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    };
    vec![
        account(
            trader,
            system_program::ID,
            vec![],
            100_000_000_000,
            true,
            true,
            false,
        ),
        pool_account(key, &pool),
        account(
            pool.mint,
            token::ID,
            packed(SplMint {
                mint_authority: COption::None,
                supply: SUPPLY,
                decimals: DECIMALS,
                is_initialized: true,
                freeze_authority: COption::None,
            }),
            1_000_000,
            false,
            false,
            false,
        ),
        account(
            vault,
            token::ID,
            packed(token_state(key, SUPPLY)),
            1_000_000,
            false,
            true,
            false,
        ),
        account(
            reserve,
            crate::ID,
            serialized(
                &SolVault {
                    pool: key,
                    kind: 0,
                    rent_floor: 1000,
                },
                SolVault::SPACE,
            ),
            1000,
            false,
            true,
            false,
        ),
        account(
            fees,
            crate::ID,
            serialized(
                &SolVault {
                    pool: key,
                    kind: 1,
                    rent_floor: 1000,
                },
                SolVault::SPACE,
            ),
            1000,
            false,
            true,
            false,
        ),
        account(
            Pubkey::new_unique(),
            token::ID,
            packed(token_state(trader, 0)),
            1_000_000,
            false,
            true,
            false,
        ),
        account(
            token::ID,
            bpf_loader_upgradeable::ID,
            vec![],
            1,
            false,
            false,
            true,
        ),
        account(
            system_program::ID,
            bpf_loader_upgradeable::ID,
            vec![],
            1,
            false,
            false,
            true,
        ),
    ]
}

#[test]
fn real_spl_cpi_host_buy_sell_conserves_and_never_spends_virtual_sol() {
    let _lock = STUB_LOCK.lock().unwrap();
    let _restore = RestoreStubs(Some(set_syscall_stubs(Box::new(TransferStubs))));
    let accounts = trade_fixture();
    execute(
        accounts.clone(),
        crate::instruction::BuyExactIn {
            amount_in: 1_000_000_000,
            minimum_out: 31_945_788_964_181,
            expiry_slot: 100,
        }
        .data(),
    )
    .unwrap();
    let tokens = SplAccount::unpack(&accounts[6].try_borrow_data().unwrap())
        .unwrap()
        .amount;
    assert_eq!(tokens, 31_945_788_964_181);
    assert_eq!(accounts[0].lamports(), 99_000_000_000);
    assert_eq!(accounts[4].lamports(), 990_001_000);
    assert_eq!(accounts[5].lamports(), 10_001_000);
    execute(
        accounts.clone(),
        crate::instruction::SellExactIn {
            amount_in: tokens,
            minimum_out: 980_099_999,
            expiry_slot: 100,
        }
        .data(),
    )
    .unwrap();
    assert_eq!(
        SplAccount::unpack(&accounts[6].try_borrow_data().unwrap())
            .unwrap()
            .amount,
        0
    );
    assert_eq!(
        SplAccount::unpack(&accounts[3].try_borrow_data().unwrap())
            .unwrap()
            .amount,
        SUPPLY
    );
    assert_eq!(accounts[0].lamports(), 99_980_099_999);
    assert_eq!(accounts[4].lamports(), 1001);
    assert_eq!(accounts[5].lamports(), 19_901_000);
    let pool = Pool::try_deserialize(&mut accounts[1].try_borrow_data().unwrap().as_ref()).unwrap();
    assert_eq!(pool.sequence, 2);
    assert_eq!(pool.fees_earned, 19_900_000);
    assert_eq!(pool.sol_reserve, 1);
}

#[test]
fn trade_constraints_slippage_expiry_authority_and_substitution_reject_before_cpi() {
    let _lock = STUB_LOCK.lock().unwrap();
    let _restore = RestoreStubs(Some(set_syscall_stubs(Box::new(TransferStubs))));
    for mode in 0..8 {
        let mut accounts = trade_fixture();
        let mut expiry_slot = 100;
        let mut minimum_out = 1;
        match mode {
            0 => expiry_slot = 99,
            1 => minimum_out = SUPPLY,
            2 => accounts[0].is_signer = false,
            3 => {
                accounts[7] = account(
                    Pubkey::new_unique(),
                    bpf_loader_upgradeable::ID,
                    vec![],
                    1,
                    false,
                    false,
                    true,
                )
            }
            4 => accounts.swap(4, 5),
            5 => accounts[6] = accounts[3].clone(),
            6 => {
                let mut mint = SplMint::unpack(&accounts[2].try_borrow_data().unwrap()).unwrap();
                mint.mint_authority = COption::Some(Pubkey::new_unique());
                SplMint::pack(mint, &mut accounts[2].try_borrow_mut_data().unwrap()).unwrap();
            }
            7 => {
                let mut vault =
                    SplAccount::unpack(&accounts[3].try_borrow_data().unwrap()).unwrap();
                vault.delegate = COption::Some(Pubkey::new_unique());
                SplAccount::pack(vault, &mut accounts[3].try_borrow_mut_data().unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        let before_sol = accounts[0].lamports();
        assert!(
            execute(
                accounts.clone(),
                crate::instruction::BuyExactIn {
                    amount_in: 1_000_000_000,
                    minimum_out,
                    expiry_slot
                }
                .data()
            )
            .is_err(),
            "mode {mode}"
        );
        assert_eq!(accounts[0].lamports(), before_sol);
    }
}

#[test]
fn donated_sol_and_tokens_are_not_priced_or_claimable() {
    let _lock = STUB_LOCK.lock().unwrap();
    let _restore = RestoreStubs(Some(set_syscall_stubs(Box::new(TransferStubs))));
    let accounts = trade_fixture();
    execute(
        accounts.clone(),
        crate::instruction::BuyExactIn {
            amount_in: 1_000_000_000,
            minimum_out: 1,
            expiry_slot: 100,
        }
        .data(),
    )
    .unwrap();
    // Ordinary unsolicited transfers represented as external balance changes.
    **accounts[4].try_borrow_mut_lamports().unwrap() += 5_000_000_000;
    **accounts[5].try_borrow_mut_lamports().unwrap() += 1_000_000;
    let mut trader = SplAccount::unpack(&accounts[6].try_borrow_data().unwrap()).unwrap();
    let donated = 1_000_000;
    trader.amount -= donated;
    let mut vault = SplAccount::unpack(&accounts[3].try_borrow_data().unwrap()).unwrap();
    vault.amount += donated;
    SplAccount::pack(trader, &mut accounts[6].try_borrow_mut_data().unwrap()).unwrap();
    SplAccount::pack(vault, &mut accounts[3].try_borrow_mut_data().unwrap()).unwrap();
    let before =
        Pool::try_deserialize(&mut accounts[1].try_borrow_data().unwrap().as_ref()).unwrap();
    let expected = math::buy(
        before.token_reserve,
        before.sol_reserve,
        before.virtual_sol,
        before.fee_bps,
        1_000_000_000,
    )
    .unwrap();
    execute(
        accounts.clone(),
        crate::instruction::BuyExactIn {
            amount_in: 1_000_000_000,
            minimum_out: expected.amount_out,
            expiry_slot: 100,
        }
        .data(),
    )
    .unwrap();
    let after =
        Pool::try_deserialize(&mut accounts[1].try_borrow_data().unwrap().as_ref()).unwrap();
    assert_eq!(after.sol_reserve, expected.sol_reserve);
    assert_eq!(
        accounts[4].lamports(),
        1000 + expected.sol_reserve + 5_000_000_000
    );
    assert_eq!(
        SplAccount::unpack(&accounts[3].try_borrow_data().unwrap())
            .unwrap()
            .amount,
        after.token_reserve + donated
    );
    assert_eq!(
        accounts[5].lamports(),
        1000 + u64::try_from(after.fees_earned).unwrap() + 1_000_000
    );
}

fn account(
    key: Pubkey,
    owner: Pubkey,
    data: Vec<u8>,
    lamports: u64,
    signer: bool,
    writable: bool,
    executable: bool,
) -> AccountInfo<'static> {
    AccountInfo::new(
        Box::leak(Box::new(key)),
        signer,
        writable,
        Box::leak(Box::new(lamports)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(owner)),
        executable,
        0,
    )
}
fn serialized<T: AccountSerialize>(value: &T, size: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    value.try_serialize(&mut bytes).unwrap();
    assert!(bytes.len() <= size);
    bytes.resize(size, 0);
    bytes
}
fn fixture_pool(status: u8) -> (Pubkey, Pool) {
    let creator = Pubkey::new_unique();
    let nonce = 91u64;
    let (key, bump) = Pubkey::find_program_address(
        &[b"pool", creator.as_ref(), &nonce.to_le_bytes()],
        &crate::ID,
    );
    let mint = Pubkey::find_program_address(&[b"mint", key.as_ref()], &crate::ID).0;
    let mut recipients = [Recipient::default(); 7];
    recipients[0] = Recipient {
        address: creator,
        weight_bps: 10_000,
        paid: 0,
    };
    (
        key,
        Pool {
            version: 1,
            status,
            bump,
            nonce,
            creator,
            rent_payer: creator,
            mint,
            virtual_sol: 30_000_000_000,
            fee_bps: 100,
            recipient_count: 1,
            recipients,
            token_reserve: SUPPLY,
            sol_reserve: 0,
            fees_earned: 0,
            sequence: 0,
            name: "Launch".into(),
            symbol: "L".into(),
            uri: "https://example.invalid/token.json".into(),
            content_hash: [0; 32],
        },
    )
}
fn pool_account(key: Pubkey, pool: &Pool) -> AccountInfo<'static> {
    account(
        key,
        crate::ID,
        serialized(pool, Pool::SPACE),
        100_000_000,
        false,
        true,
        false,
    )
}
fn execute(
    accounts: Vec<AccountInfo<'static>>,
    data: Vec<u8>,
) -> anchor_lang::solana_program::entrypoint::ProgramResult {
    // Anchor entry ties the slice and account lifetimes. Leaks are bounded fixtures.
    crate::entry(&crate::ID, Box::leak(accounts.into_boxed_slice()), &data)
}
fn terms() -> PrepareArgs {
    PrepareArgs {
        nonce: 1,
        virtual_sol: MIN_VIRTUAL_SOL,
        fee_bps: 100,
        name: "Launch".into(),
        symbol: "TOKEN".into(),
        uri: String::new(),
        content_hash: [0; 32],
        recipients: vec![RecipientInput {
            address: Pubkey::new_unique(),
            weight_bps: 10_000,
        }],
    }
}

#[test]
fn canonical_terms_and_metadata_are_bounded() {
    let pool = Pubkey::new_unique();
    let mut args = terms();
    validate_terms(&args, &pool).unwrap();
    args.name = "é".repeat(17);
    assert!(validate_terms(&args, &pool).is_err());
    args.name = "Good".into();
    args.symbol = "A\nB".into();
    assert!(validate_terms(&args, &pool).is_err());
    args.symbol = "OK".into();
    args.uri = "x".repeat(201);
    assert!(validate_terms(&args, &pool).is_err());
    args.uri.clear();
    args.virtual_sol = MAX_VIRTUAL_SOL + 1;
    assert!(validate_terms(&args, &pool).is_err());
}
#[test]
fn recipient_aliases_duplicates_and_weights_rejected() {
    let pool = Pubkey::new_unique();
    let mut args = terms();
    args.recipients[0].address = pool;
    assert!(validate_terms(&args, &pool).is_err());
    for seed in [
        b"mint".as_slice(),
        b"token",
        b"fees",
        b"reserve",
        b"mint-authority",
    ] {
        args.recipients[0].address =
            Pubkey::find_program_address(&[seed, pool.as_ref()], &crate::ID).0;
        assert!(validate_terms(&args, &pool).is_err());
    }
    args = terms();
    args.recipients.push(args.recipients[0].clone());
    assert!(validate_terms(&args, &pool).is_err());
    args = terms();
    args.recipients[0].weight_bps = 9999;
    assert!(validate_terms(&args, &pool).is_err());
    args = terms();
    args.fee_bps = 0;
    assert!(validate_terms(&args, &pool).is_err());
    args.recipients.clear();
    validate_terms(&args, &pool).unwrap();
}
#[test]
fn off_curve_smart_wallet_recipient_is_supported() {
    let mut args = terms();
    args.recipients[0].address =
        Pubkey::find_program_address(&[b"wallet"], &Pubkey::new_unique()).0;
    assert!(!args.recipients[0].address.is_on_curve());
    validate_terms(&args, &Pubkey::new_unique()).unwrap();
}
fn loader_accounts(authority: Option<Pubkey>) -> (AccountInfo<'static>, AccountInfo<'static>) {
    let data_key =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
    let program_bytes =
        bincode::serialize(&bpf_loader_upgradeable::UpgradeableLoaderState::Program {
            programdata_address: data_key,
        })
        .unwrap();
    let mut data_bytes = bincode::serialize(
        &bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
            slot: 1,
            upgrade_authority_address: authority,
        },
    )
    .unwrap();
    data_bytes.resize(64, 0);
    (
        account(
            crate::ID,
            bpf_loader_upgradeable::ID,
            program_bytes,
            1,
            false,
            false,
            true,
        ),
        account(
            data_key,
            bpf_loader_upgradeable::ID,
            data_bytes,
            1,
            false,
            false,
            false,
        ),
    )
}
#[test]
fn immutable_gate_requires_own_program_and_revoked_linked_data() {
    let (executable, data) = loader_accounts(None);
    verify_immutable(&executable, &data).unwrap();
    let (_, mutable_data) = loader_accounts(Some(Pubkey::new_unique()));
    assert!(verify_immutable(&executable, &mutable_data).is_err());
    let unrelated = account(
        Pubkey::new_unique(),
        bpf_loader_upgradeable::ID,
        data.try_borrow_data().unwrap().to_vec(),
        1,
        false,
        false,
        false,
    );
    assert!(verify_immutable(&executable, &unrelated).is_err());
    let wrong_owner = account(
        *data.key,
        system_program::ID,
        data.try_borrow_data().unwrap().to_vec(),
        1,
        false,
        false,
        false,
    );
    assert!(verify_immutable(&executable, &wrong_owner).is_err());
    let non_executable = account(
        crate::ID,
        bpf_loader_upgradeable::ID,
        executable.try_borrow_data().unwrap().to_vec(),
        1,
        false,
        false,
        false,
    );
    assert!(verify_immutable(&non_executable, &data).is_err());
    let spoofed_code =
        bincode::serialize(&bpf_loader_upgradeable::UpgradeableLoaderState::Program {
            programdata_address: Pubkey::new_unique(),
        })
        .unwrap();
    let spoofed = account(
        crate::ID,
        bpf_loader_upgradeable::ID,
        spoofed_code,
        1,
        false,
        false,
        true,
    );
    assert!(verify_immutable(&spoofed, &data).is_err());
    let short = account(
        *data.key,
        bpf_loader_upgradeable::ID,
        vec![3, 0, 0, 0],
        1,
        false,
        false,
        false,
    );
    assert!(verify_immutable(&executable, &short).is_err());
}
#[test]
fn cancellation_runs_through_entrypoint_and_cannot_replay() {
    let (key, pool) = fixture_pool(PREPARED);
    let state = pool_account(key, &pool);
    let creator = account(
        pool.creator,
        system_program::ID,
        vec![],
        1,
        true,
        false,
        false,
    );
    execute(
        vec![creator.clone(), state.clone()],
        crate::instruction::CancelPreparation {}.data(),
    )
    .unwrap();
    let result = Pool::try_deserialize(&mut state.try_borrow_data().unwrap().as_ref()).unwrap();
    assert_eq!(result.status, CANCELLED);
    assert_eq!(state.lamports(), 100_000_000);
    assert!(execute(
        vec![creator, state],
        crate::instruction::CancelPreparation {}.data()
    )
    .is_err());
}
#[test]
fn active_cancellation_and_unsigned_wrong_creator_rejected() {
    for (status, signer, wrong_creator) in [
        (ACTIVE, true, false),
        (PREPARED, false, false),
        (PREPARED, true, true),
    ] {
        let (key, pool) = fixture_pool(status);
        let creator = account(
            if wrong_creator {
                Pubkey::new_unique()
            } else {
                pool.creator
            },
            system_program::ID,
            vec![],
            1,
            signer,
            false,
            false,
        );
        assert!(execute(
            vec![creator, pool_account(key, &pool)],
            crate::instruction::CancelPreparation {}.data()
        )
        .is_err());
    }
}
#[test]
fn wrong_pool_owner_pda_and_readonly_state_rejected() {
    for mode in 0..3 {
        let (key, pool) = fixture_pool(PREPARED);
        let creator = account(
            pool.creator,
            system_program::ID,
            vec![],
            1,
            true,
            false,
            false,
        );
        let state = account(
            if mode == 0 { Pubkey::new_unique() } else { key },
            if mode == 1 {
                system_program::ID
            } else {
                crate::ID
            },
            serialized(&pool, Pool::SPACE),
            100_000_000,
            false,
            mode != 2,
            false,
        );
        assert!(execute(
            vec![creator, state],
            crate::instruction::CancelPreparation {}.data()
        )
        .is_err());
    }
}
fn claim_fixture(
    donation: u64,
) -> (
    AccountInfo<'static>,
    AccountInfo<'static>,
    AccountInfo<'static>,
) {
    let (key, mut pool) = fixture_pool(ACTIVE);
    pool.fees_earned = 777;
    let fees_key = Pubkey::find_program_address(&[b"fees", key.as_ref()], &crate::ID).0;
    let fee_state = SolVault {
        pool: key,
        kind: 1,
        rent_floor: 1000,
    };
    (
        pool_account(key, &pool),
        account(
            fees_key,
            crate::ID,
            serialized(&fee_state, SolVault::SPACE),
            1777 + donation,
            false,
            true,
            false,
        ),
        account(
            pool.creator,
            system_program::ID,
            vec![],
            500,
            false,
            true,
            false,
        ),
    )
}
#[test]
fn permissionless_claim_preserves_rent_and_donations_and_cannot_double_pay() {
    let (pool, fees, recipient) = claim_fixture(5000);
    execute(
        vec![pool.clone(), fees.clone(), recipient.clone()],
        crate::instruction::ClaimFees { recipient_index: 0 }.data(),
    )
    .unwrap();
    assert_eq!(recipient.lamports(), 1277);
    assert_eq!(fees.lamports(), 6000);
    let state = Pool::try_deserialize(&mut pool.try_borrow_data().unwrap().as_ref()).unwrap();
    assert_eq!(state.recipients[0].paid, 777);
    assert_eq!(state.sol_reserve, 0);
    assert_eq!(state.token_reserve, SUPPLY);
    assert!(execute(
        vec![pool, fees, recipient],
        crate::instruction::ClaimFees { recipient_index: 0 }.data()
    )
    .is_err());
}
#[test]
fn forged_recipient_and_fee_vault_substitution_rejected() {
    let (pool, fees, recipient) = claim_fixture(0);
    let attacker = account(
        Pubkey::new_unique(),
        system_program::ID,
        vec![],
        1,
        false,
        true,
        false,
    );
    assert!(execute(
        vec![pool.clone(), fees.clone(), attacker],
        crate::instruction::ClaimFees { recipient_index: 0 }.data()
    )
    .is_err());
    let forged_fees = account(
        Pubkey::new_unique(),
        crate::ID,
        fees.try_borrow_data().unwrap().to_vec(),
        1777,
        false,
        true,
        false,
    );
    assert!(execute(
        vec![pool.clone(), forged_fees, recipient.clone()],
        crate::instruction::ClaimFees { recipient_index: 0 }.data()
    )
    .is_err());
    assert!(execute(
        vec![pool, fees, recipient],
        crate::instruction::ClaimFees { recipient_index: 7 }.data()
    )
    .is_err());
}
#[test]
fn claims_never_drain_protected_rent() {
    let (pool, fees, recipient) = claim_fixture(0);
    **fees.try_borrow_mut_lamports().unwrap() = 1776;
    assert!(execute(
        vec![pool, fees.clone(), recipient.clone()],
        crate::instruction::ClaimFees { recipient_index: 0 }.data()
    )
    .is_err());
    assert_eq!(fees.lamports(), 1776);
    assert_eq!(recipient.lamports(), 500);
}
#[test]
fn max_metadata_account_size_matches_abi() {
    let (_, mut pool) = fixture_pool(PREPARED);
    pool.name = "x".repeat(32);
    pool.symbol = "x".repeat(10);
    pool.uri = "x".repeat(200);
    let mut bytes = Vec::new();
    pool.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), Pool::SPACE);
}
#[test]
fn independent_golden_vectors() {
    let rows: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/solana-model/golden-vectors.json"
    ))
    .unwrap();
    for row in rows.as_array().unwrap() {
        let s = &row["state"];
        let value = |v: &serde_json::Value| v.as_str().unwrap().parse::<u64>().unwrap();
        let calc = if row["side"] == "buy" {
            math::buy
        } else {
            math::sell
        };
        let q = calc(
            value(&s["tokenInventory"]),
            value(&s["realSolReserves"]),
            value(&s["virtualSol"]),
            s["feeBps"].as_u64().unwrap() as u16,
            value(&row["input"]),
        )
        .unwrap();
        let expected = &row["expected"];
        assert_eq!(
            q.amount_out,
            value(&expected["amountOut"]),
            "{}",
            row["name"]
        );
        assert_eq!(q.fee, value(&expected["fee"]));
        assert_eq!(q.token_reserve, value(&expected["nextTokenInventory"]));
        assert_eq!(q.sol_reserve, value(&expected["nextRealSolReserves"]));
    }
}

#[test]
fn sdk_fixture_matches_rust_serialization_pdas_and_instruction_accounts() {
    use anchor_lang::ToAccountMetas;
    use std::str::FromStr;
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../app/packages/solana-sdk/tests/abi-fixture.json"
    ))
    .unwrap();
    let hex = |value: &serde_json::Value| {
        let text = value.as_str().unwrap();
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>()
    };
    let pubkey = |value: &serde_json::Value| Pubkey::from_str(value.as_str().unwrap()).unwrap();
    let bytes = hex(&fixture["preparedPoolHex"]);
    let pool = Pool::try_deserialize(&mut bytes.as_slice()).unwrap();
    assert_eq!(pool.creator, Pubkey::new_from_array([1; 32]));
    assert_eq!(pool.nonce, 7);
    assert_eq!(pool.status, PREPARED);
    assert_eq!(pool.name, "Example");
    assert_eq!(pool.symbol, "EX");
    assert!(pool.uri.is_empty());
    assert_eq!(pool.fee_bps, 0);
    let mut round_trip = Vec::new();
    pool.try_serialize(&mut round_trip).unwrap();
    assert_eq!(round_trip, bytes);
    let (pool_key, bump) = Pubkey::find_program_address(
        &[b"pool", pool.creator.as_ref(), &7u64.to_le_bytes()],
        &crate::ID,
    );
    assert_eq!(pool_key, pubkey(&fixture["addresses"]["pool"]));
    assert_eq!(bump, pool.bump);
    for (seed, name) in [
        (b"mint".as_slice(), "mint"),
        (b"token", "tokenVault"),
        (b"reserve", "reserve"),
        (b"fees", "fees"),
        (b"mint-authority", "mintAuthority"),
    ] {
        assert_eq!(
            Pubkey::find_program_address(&[seed, pool_key.as_ref()], &crate::ID).0,
            pubkey(&fixture["addresses"][name])
        );
    }
    let args = PrepareArgs {
        nonce: 7,
        virtual_sol: 30_000_000_000,
        fee_bps: 0,
        name: "Example".into(),
        symbol: "EX".into(),
        uri: String::new(),
        content_hash: [0; 32],
        recipients: vec![],
    };
    let instruction_data = [
        (
            "prepareLaunch",
            crate::instruction::PrepareLaunch { args }.data(),
        ),
        (
            "activateLaunch",
            crate::instruction::ActivateLaunch {}.data(),
        ),
        (
            "cancelPreparation",
            crate::instruction::CancelPreparation {}.data(),
        ),
        (
            "buyExactIn",
            crate::instruction::BuyExactIn {
                amount_in: 1_000_000_000,
                minimum_out: 10,
                expiry_slot: 1000,
            }
            .data(),
        ),
        (
            "sellExactIn",
            crate::instruction::SellExactIn {
                amount_in: 1_000_000_000,
                minimum_out: 10,
                expiry_slot: 1000,
            }
            .data(),
        ),
        (
            "claimFees",
            crate::instruction::ClaimFees { recipient_index: 0 }.data(),
        ),
    ];
    for (name, bytes) in instruction_data {
        assert_eq!(
            bytes,
            hex(&fixture["instructions"][name]["dataHex"]),
            "{name}"
        );
    }
    let address = |name: &str| pubkey(&fixture["addresses"][name]);
    let trade = crate::accounts::Trade {
        trader: pool.creator,
        pool: pool_key,
        mint: address("mint"),
        token_vault: address("tokenVault"),
        reserve: address("reserve"),
        fees: address("fees"),
        trader_token: pubkey(&fixture["instructions"]["buyExactIn"]["keys"][6]["address"]),
        token_program: token::ID,
        system_program: system_program::ID,
    };
    let metas = [
        (
            "prepareLaunch",
            crate::accounts::PrepareLaunch {
                creator: pool.creator,
                payer: pool.creator,
                pool: pool_key,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        (
            "activateLaunch",
            crate::accounts::ActivateLaunch {
                creator: pool.creator,
                pool: pool_key,
                mint: address("mint"),
                token_vault: address("tokenVault"),
                reserve: address("reserve"),
                fees: address("fees"),
                mint_authority: address("mintAuthority"),
                executable: crate::ID,
                program_data: Pubkey::find_program_address(
                    &[crate::ID.as_ref()],
                    &bpf_loader_upgradeable::ID,
                )
                .0,
                token_program: token::ID,
                system_program: system_program::ID,
                rent: anchor_lang::solana_program::sysvar::rent::ID,
            }
            .to_account_metas(None),
        ),
        (
            "cancelPreparation",
            crate::accounts::CancelPreparation {
                creator: pool.creator,
                pool: pool_key,
            }
            .to_account_metas(None),
        ),
        ("buyExactIn", trade.to_account_metas(None)),
        ("sellExactIn", trade.to_account_metas(None)),
        (
            "claimFees",
            crate::accounts::ClaimFees {
                pool: pool_key,
                fees: address("fees"),
                recipient: pool.creator,
            }
            .to_account_metas(None),
        ),
    ];
    for (name, keys) in metas {
        let expected = fixture["instructions"][name]["keys"].as_array().unwrap();
        assert_eq!(keys.len(), expected.len());
        for (key, expected) in keys.iter().zip(expected) {
            assert_eq!(key.pubkey, pubkey(&expected["address"]), "{name}");
            assert_eq!(
                key.is_signer,
                expected["signer"].as_bool().unwrap(),
                "{name}"
            );
            assert_eq!(
                key.is_writable,
                expected["writable"].as_bool().unwrap(),
                "{name}"
            );
        }
    }
}
