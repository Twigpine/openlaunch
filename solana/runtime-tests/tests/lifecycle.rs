//! Offline execution of the compiled SBPFv3 ELF with real System/SPL programs.
//! Ephemeral VM-only identities are generated in memory; no RPC or wallets.
use anchor_lang::prelude::Pubkey;
#[allow(deprecated)]
// Exercise the same legacy System instruction bytes as Anchor's CPI client.
use anchor_lang::solana_program::{
    instruction::Instruction as OldInstruction, program_pack::Pack, system_instruction,
};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token::spl_token::{
    self,
    state::{Account as TokenAccount, Mint},
};
use launch_pool::{
    math::SUPPLY, Pool, PrepareArgs, RecipientInput, SolVault, ACTIVE, CANCELLED, PREPARED,
};
use litesvm::{
    types::{FailedTransactionMetadata, TransactionMetadata},
    LiteSVM,
};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{account_meta::AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

fn address(key: Pubkey) -> Address {
    Address::new_from_array(key.to_bytes())
}
fn pubkey(key: Address) -> Pubkey {
    Pubkey::new_from_array(key.to_bytes())
}
fn convert(ix: OldInstruction) -> Instruction {
    Instruction {
        program_id: address(ix.program_id),
        accounts: ix
            .accounts
            .into_iter()
            .map(|a| AccountMeta {
                pubkey: address(a.pubkey),
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}
fn instruction(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    convert(OldInstruction {
        program_id: launch_pool::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    })
}

struct Fixture {
    last_packet_bytes: usize,
    svm: LiteSVM,
    payer: Keypair,
    nonce: u64,
    pool: Pubkey,
    mint: Pubkey,
    token: Pubkey,
    reserve: Pubkey,
    fees: Pubkey,
    mint_authority: Pubkey,
    program_data: Pubkey,
}
impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/deploy/launch_pool.so"
        ))
        .expect("Build ELF with scripts/check-sbf.sh before svm-tests");
        svm.add_program(address(launch_pool::ID), &bytes).unwrap();
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let nonce = 7u64;
        let creator = pubkey(payer.pubkey());
        let pool = Pubkey::find_program_address(
            &[b"pool", creator.as_ref(), &nonce.to_le_bytes()],
            &launch_pool::ID,
        )
        .0;
        let derive =
            |seed: &[u8]| Pubkey::find_program_address(&[seed, pool.as_ref()], &launch_pool::ID).0;
        let program_data = Pubkey::find_program_address(
            &[launch_pool::ID.as_ref()],
            &anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        )
        .0;
        Self {
            last_packet_bytes: 0,
            svm,
            payer,
            nonce,
            pool,
            mint: derive(b"mint"),
            token: derive(b"token"),
            reserve: derive(b"reserve"),
            fees: derive(b"fees"),
            mint_authority: derive(b"mint-authority"),
            program_data,
        }
    }
    fn send(
        &mut self,
        instructions: &[Instruction],
        extra: &[&Keypair],
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        self.svm.expire_blockhash();
        let blockhash = self.svm.latest_blockhash();
        let mut signers = vec![&self.payer];
        signers.extend_from_slice(extra);
        let transaction = Transaction::new(
            &signers,
            Message::new_with_blockhash(instructions, Some(&self.payer.pubkey()), &blockhash),
            blockhash,
        );
        let bytes = bincode::serialize(&transaction).unwrap();
        self.last_packet_bytes = bytes.len();
        assert!(bytes.len() <= 1232, "packet {} exceeds 1232", bytes.len());
        self.svm.send_transaction(transaction).map_err(Box::new)
    }
    fn args(&self) -> PrepareArgs {
        PrepareArgs {
            nonce: self.nonce,
            virtual_sol: 30_000_000_000,
            fee_bps: 100,
            name: "Openlaunch test".into(),
            symbol: "TEST".into(),
            uri: String::new(),
            content_hash: [0; 32],
            recipients: vec![RecipientInput {
                address: pubkey(self.payer.pubkey()),
                weight_bps: 10_000,
            }],
        }
    }
    fn prepare_ix(&self, args: PrepareArgs) -> Instruction {
        instruction(
            launch_pool::accounts::PrepareLaunch {
                creator: pubkey(self.payer.pubkey()),
                payer: pubkey(self.payer.pubkey()),
                pool: self.pool,
                system_program: anchor_lang::system_program::ID,
            },
            launch_pool::instruction::PrepareLaunch { args },
        )
    }
    fn prepare(&mut self) {
        let ix = self.prepare_ix(self.args());
        let result = self.send(&[ix], &[]).unwrap();
        println!("prepare CU={}", result.compute_units_consumed);
    }
    fn activate_ix(&self) -> Instruction {
        instruction(
            launch_pool::accounts::ActivateLaunch {
                creator: pubkey(self.payer.pubkey()),
                pool: self.pool,
                mint: self.mint,
                token_vault: self.token,
                reserve: self.reserve,
                fees: self.fees,
                mint_authority: self.mint_authority,
                executable: launch_pool::ID,
                program_data: self.program_data,
                token_program: spl_token::ID,
                system_program: anchor_lang::system_program::ID,
                rent: anchor_lang::solana_program::sysvar::rent::ID,
            },
            launch_pool::instruction::ActivateLaunch {},
        )
    }
    fn activate(&mut self) {
        let ix = self.activate_ix();
        let result = self.send(&[ix], &[]).unwrap();
        println!("activate CU={}", result.compute_units_consumed);
    }
    fn pool_state(&self) -> Pool {
        Pool::try_deserialize(
            &mut self
                .svm
                .get_account(&address(self.pool))
                .unwrap()
                .data
                .as_slice(),
        )
        .unwrap()
    }
    fn vault_state(&self, key: Pubkey) -> SolVault {
        SolVault::try_deserialize(&mut self.svm.get_account(&address(key)).unwrap().data.as_slice())
            .unwrap()
    }
    fn lamports(&self, key: Pubkey) -> u64 {
        self.svm.get_account(&address(key)).unwrap().lamports
    }
    fn token_amount(&self, key: Pubkey) -> u64 {
        TokenAccount::unpack(&self.svm.get_account(&address(key)).unwrap().data)
            .unwrap()
            .amount
    }
    fn create_trader_token(&mut self) -> Pubkey {
        let token = Keypair::new();
        let token_key = pubkey(token.pubkey());
        let create = convert(system_instruction::create_account(
            &pubkey(self.payer.pubkey()),
            &token_key,
            self.svm
                .minimum_balance_for_rent_exemption(TokenAccount::LEN),
            TokenAccount::LEN as u64,
            &spl_token::ID,
        ));
        let initialize = convert(
            spl_token::instruction::initialize_account3(
                &spl_token::ID,
                &token_key,
                &self.mint,
                &pubkey(self.payer.pubkey()),
            )
            .unwrap(),
        );
        self.send(&[create, initialize], &[&token]).unwrap();
        token_key
    }
    fn trade_accounts(&self, trader_token: Pubkey) -> launch_pool::accounts::Trade {
        launch_pool::accounts::Trade {
            trader: pubkey(self.payer.pubkey()),
            pool: self.pool,
            mint: self.mint,
            token_vault: self.token,
            reserve: self.reserve,
            fees: self.fees,
            trader_token,
            token_program: spl_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
    }
    fn buy_ix(&self, trader_token: Pubkey, input: u64, minimum: u64) -> Instruction {
        instruction(
            self.trade_accounts(trader_token),
            launch_pool::instruction::BuyExactIn {
                amount_in: input,
                minimum_out: minimum,
                expiry_slot: self.svm.get_sysvar::<Clock>().slot + 100,
            },
        )
    }
    fn sell_ix(&self, trader_token: Pubkey, input: u64, minimum: u64) -> Instruction {
        instruction(
            self.trade_accounts(trader_token),
            launch_pool::instruction::SellExactIn {
                amount_in: input,
                minimum_out: minimum,
                expiry_slot: self.svm.get_sysvar::<Clock>().slot + 100,
            },
        )
    }
    fn claim_ix(&self, index: u8, recipient: Pubkey) -> Instruction {
        instruction(
            launch_pool::accounts::ClaimFees {
                pool: self.pool,
                fees: self.fees,
                recipient,
            },
            launch_pool::instruction::ClaimFees {
                recipient_index: index,
            },
        )
    }
    fn cancel_ix(&self) -> Instruction {
        instruction(
            launch_pool::accounts::CancelPreparation {
                creator: pubkey(self.payer.pubkey()),
                pool: self.pool,
            },
            launch_pool::instruction::CancelPreparation {},
        )
    }
    fn prefund(&mut self, key: Pubkey) {
        let ix = convert(system_instruction::transfer(
            &pubkey(self.payer.pubkey()),
            &key,
            1_000_000,
        ));
        self.send(&[ix], &[]).unwrap();
    }
}

#[test]
fn real_sbf_lifecycle_atomic_mint_revoke_buy_sell_claim() {
    let mut f = Fixture::new();
    f.prepare();
    assert_eq!(f.pool_state().status, PREPARED);
    f.activate();
    let state = f.pool_state();
    assert_eq!(state.status, ACTIVE);
    assert_eq!(state.token_reserve, SUPPLY);
    let mint = Mint::unpack(&f.svm.get_account(&address(f.mint)).unwrap().data).unwrap();
    assert_eq!(mint.supply, SUPPLY);
    assert_eq!(mint.decimals, 6);
    assert!(mint.mint_authority.is_none());
    assert!(mint.freeze_authority.is_none());
    assert_eq!(f.token_amount(f.token), SUPPLY);
    let token = f.create_trader_token();
    let buy = f.buy_ix(token, 1_000_000_000, 31_945_788_964_181);
    let result = f.send(&[buy], &[]).unwrap();
    println!("buy CU={}", result.compute_units_consumed);
    assert_eq!(f.token_amount(token), 31_945_788_964_181);
    assert_eq!(f.pool_state().sol_reserve, 990_000_000);
    let sell = f.sell_ix(token, f.token_amount(token), 980_099_999);
    let result = f.send(&[sell], &[]).unwrap();
    println!("sell CU={}", result.compute_units_consumed);
    assert_eq!(f.token_amount(token), 0);
    assert_eq!(f.pool_state().sol_reserve, 1);
    assert_eq!(f.pool_state().fees_earned, 19_900_000);
    let rent = f.vault_state(f.fees).rent_floor;
    let claim = f.claim_ix(0, pubkey(f.payer.pubkey()));
    let result = f.send(std::slice::from_ref(&claim), &[]).unwrap();
    println!("claim CU={}", result.compute_units_consumed);
    assert_eq!(f.lamports(f.fees), rent);
    assert_eq!(f.pool_state().recipients[0].paid, 19_900_000);
    assert!(f.send(&[claim], &[]).is_err());
    assert!(f.send(&[f.cancel_ix()], &[]).is_err());
    assert!(f.send(&[f.activate_ix()], &[]).is_err());
}

#[test]
fn prefunded_pool_and_all_activation_pdas_cannot_grief_creation() {
    for index in 0..5 {
        let mut f = Fixture::new();
        let target = [f.pool, f.mint, f.token, f.reserve, f.fees][index];
        f.prefund(target);
        f.prepare();
        f.activate();
        assert_eq!(f.pool_state().status, ACTIVE);
        assert_eq!(f.token_amount(f.token), SUPPLY);
    }
}

#[test]
fn cancelled_nonce_is_terminal_and_active_pool_cannot_reinitialize() {
    let mut f = Fixture::new();
    f.prepare();
    let cancel = f.cancel_ix();
    f.send(std::slice::from_ref(&cancel), &[]).unwrap();
    assert_eq!(f.pool_state().status, CANCELLED);
    assert!(f.send(&[cancel], &[]).is_err());
    assert!(f.send(&[f.prepare_ix(f.args())], &[]).is_err());
    assert!(f.send(&[f.activate_ix()], &[]).is_err());
    assert!(f.svm.get_account(&address(f.mint)).is_none());
}

#[test]
fn failed_later_instruction_rolls_back_successful_activation_and_buy_cpis() {
    let mut f = Fixture::new();
    f.prepare();
    // Activation succeeds internally; the following active cancellation must fail.
    assert!(f.send(&[f.activate_ix(), f.cancel_ix()], &[]).is_err());
    assert_eq!(f.pool_state().status, PREPARED);
    assert!(f.svm.get_account(&address(f.mint)).is_none());
    f.activate();
    let token = f.create_trader_token();
    let initial_fees = f.lamports(f.fees);
    let initial_reserve = f.lamports(f.reserve);
    let good_buy = f.buy_ix(token, 1_000_000_000, 1);
    let impossible_buy = f.buy_ix(token, 1_000_000_000, SUPPLY);
    assert!(f.send(&[good_buy, impossible_buy], &[]).is_err());
    assert_eq!(f.token_amount(token), 0);
    assert_eq!(f.pool_state().sequence, 0);
    assert_eq!(f.lamports(f.fees), initial_fees);
    assert_eq!(f.lamports(f.reserve), initial_reserve);
}

#[test]
fn maximum_terms_fit_packet_and_compute_limits() {
    let mut f = Fixture::new();
    let mut args = f.args();
    args.name = "N".repeat(32);
    args.symbol = "S".repeat(10);
    args.uri = "u".repeat(200);
    args.recipients = (0..7)
        .map(|i| RecipientInput {
            address: Pubkey::new_unique(),
            weight_bps: if i == 6 { 1432 } else { 1428 },
        })
        .collect();
    let ix = f.prepare_ix(args);
    let meta = f.send(&[ix], &[]).unwrap();
    println!(
        "max prepare CU={} packet={} bytes",
        meta.compute_units_consumed, f.last_packet_bytes
    );
    f.activate();
    assert_eq!(f.pool_state().recipient_count, 7);
}

#[test]
fn wrong_custody_accounts_and_expiry_reject_without_movement() {
    let mut f = Fixture::new();
    f.prepare();
    f.activate();
    let token = f.create_trader_token();
    for mode in 0..5 {
        let mut ix = f.buy_ix(token, 1_000_000_000, 1);
        match mode {
            0 => ix.accounts.swap(4, 5),
            1 => ix.accounts[6].pubkey = address(f.token),
            2 => ix.accounts[7].pubkey = solana_sdk_ids::system_program::ID,
            3 => ix.accounts[2].pubkey = address(f.token),
            4 => {
                f.svm.warp_to_slot(200);
                ix.data = launch_pool::instruction::BuyExactIn {
                    amount_in: 1_000_000_000,
                    minimum_out: 1,
                    expiry_slot: 100,
                }
                .data();
            }
            _ => unreachable!(),
        }
        assert!(f.send(&[ix], &[]).is_err());
        assert_eq!(f.pool_state().sequence, 0);
        assert_eq!(f.token_amount(token), 0);
    }
}

#[test]
fn mutable_or_unrelated_programdata_cannot_activate() {
    #[allow(deprecated)]
    use anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState;
    let mut f = Fixture::new();
    f.prepare();
    let mut account = f.svm.get_account(&address(f.program_data)).unwrap();
    let state = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: Some(pubkey(f.payer.pubkey())),
    })
    .unwrap();
    account.data[..45].copy_from_slice(&state);
    f.svm.set_account(address(f.program_data), account).unwrap();
    assert!(f.send(&[f.activate_ix()], &[]).is_err());
    assert_eq!(f.pool_state().status, PREPARED);
    assert!(f.svm.get_account(&address(f.mint)).is_none());
    let mut wrong_ix = f.activate_ix();
    wrong_ix.accounts[8].pubkey = f.payer.pubkey();
    assert!(f.send(&[wrong_ix], &[]).is_err());
}

#[test]
fn donations_and_holder_burns_do_not_change_quotes_or_fee_claims() {
    let mut f = Fixture::new();
    f.prepare();
    f.activate();
    let token = f.create_trader_token();
    f.send(&[f.buy_ix(token, 1_000_000_000, 1)], &[]).unwrap();
    let payer = pubkey(f.payer.pubkey());
    let donate_token = convert(
        spl_token::instruction::transfer_checked(
            &spl_token::ID,
            &token,
            &f.mint,
            &f.token,
            &payer,
            &[],
            1_000_000,
            6,
        )
        .unwrap(),
    );
    let burn = convert(
        spl_token::instruction::burn_checked(
            &spl_token::ID,
            &token,
            &f.mint,
            &payer,
            &[],
            2_000_000,
            6,
        )
        .unwrap(),
    );
    let donate_sol = convert(system_instruction::transfer(
        &payer,
        &f.reserve,
        5_000_000_000,
    ));
    let donate_fee = convert(system_instruction::transfer(&payer, &f.fees, 1_000_000));
    f.send(&[donate_token, burn, donate_sol, donate_fee], &[])
        .unwrap();
    let before = f.pool_state();
    let q = launch_pool::math::buy(
        before.token_reserve,
        before.sol_reserve,
        before.virtual_sol,
        before.fee_bps,
        1_000_000_000,
    )
    .unwrap();
    f.send(&[f.buy_ix(token, 1_000_000_000, q.amount_out)], &[])
        .unwrap();
    assert_eq!(f.pool_state().sol_reserve, q.sol_reserve);
    assert_eq!(f.token_amount(f.token), q.token_reserve + 1_000_000);
    let quote_rent = f.vault_state(f.reserve).rent_floor;
    assert_eq!(
        f.lamports(f.reserve),
        quote_rent + q.sol_reserve + 5_000_000_000
    );
    f.send(&[f.claim_ix(0, payer)], &[]).unwrap();
    assert_eq!(
        f.lamports(f.fees),
        f.vault_state(f.fees).rent_floor + 1_000_000
    );
    let sell = f.sell_ix(token, f.token_amount(token), 1);
    f.send(&[sell], &[]).unwrap();
    assert!(f.lamports(f.reserve) >= quote_rent + 5_000_000_000);
    let extra_mint = convert(
        spl_token::instruction::mint_to_checked(&spl_token::ID, &f.mint, &token, &payer, &[], 1, 6)
            .unwrap(),
    );
    assert!(f.send(&[extra_mint], &[]).is_err());
    let freeze = convert(
        spl_token::instruction::freeze_account(&spl_token::ID, &token, &f.mint, &payer, &[])
            .unwrap(),
    );
    assert!(f.send(&[freeze], &[]).is_err());
}

#[test]
fn rent_incompatible_recipient_cannot_block_another_recipient_claim() {
    let mut f = Fixture::new();
    let unused = Pubkey::new_unique();
    let payer = pubkey(f.payer.pubkey());
    let mut args = f.args();
    args.recipients = vec![
        RecipientInput {
            address: unused,
            weight_bps: 5000,
        },
        RecipientInput {
            address: payer,
            weight_bps: 5000,
        },
    ];
    f.send(&[f.prepare_ix(args)], &[]).unwrap();
    f.activate();
    let token = f.create_trader_token();
    f.send(&[f.buy_ix(token, 100, 1)], &[]).unwrap();
    f.send(&[f.buy_ix(token, 100, 1)], &[]).unwrap();
    assert_eq!(f.pool_state().fees_earned, 2);
    // One lamport cannot initialize a rent-exempt destination account.
    assert!(f.send(&[f.claim_ix(0, unused)], &[]).is_err());
    assert_eq!(f.pool_state().recipients[0].paid, 0);
    f.send(&[f.claim_ix(1, payer)], &[]).unwrap();
    assert_eq!(f.pool_state().recipients[1].paid, 1);
    assert_eq!(f.pool_state().recipients[0].paid, 0);
}
