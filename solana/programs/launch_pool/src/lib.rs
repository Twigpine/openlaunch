#![allow(unexpected_cfgs)]
// Anchor 0.31 generates a crate-level compatibility use of AccountInfo::realloc.
// Keep all other warnings denied in CI; revisit this exception when upgrading Anchor.
#![allow(deprecated)]
use anchor_lang::prelude::*;
// This pinned Anchor version reexports the legacy loader wire type. Its wire
// format is deliberately checked below; upgrading the framework is a release review.
#[allow(deprecated)]
use anchor_lang::solana_program::{bpf_loader_upgradeable, program_option::COption};
use anchor_lang::system_program::{self, Transfer as SolTransfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, TransferChecked};

pub mod math;
use math::{DECIMALS, MAX_VIRTUAL_SOL, MIN_VIRTUAL_SOL, SUPPLY};

// NONPRODUCTION compile/test fixture. A release must bind its real program ID
// into source, SDK configuration and verified build manifest before deployment.
declare_id!("Fg6PaFpoGXkYsidMpWxTWqkZPknxNpEMTZfkhHQjBcqr");

pub const PREPARED: u8 = 0;
pub const ACTIVE: u8 = 1;
pub const CANCELLED: u8 = 2;
pub const MAX_RECIPIENTS: usize = 7;

#[program]
pub mod launch_pool {
    use super::*;

    pub fn prepare_launch(ctx: Context<PrepareLaunch>, args: PrepareArgs) -> Result<()> {
        validate_terms(&args, &ctx.accounts.pool.key())?;
        let pool = &mut ctx.accounts.pool;
        pool.version = 1;
        pool.status = PREPARED;
        pool.bump = ctx.bumps.pool;
        pool.nonce = args.nonce;
        pool.creator = ctx.accounts.creator.key();
        pool.rent_payer = ctx.accounts.payer.key();
        pool.mint = Pubkey::find_program_address(&[b"mint", pool.key().as_ref()], &crate::ID).0;
        pool.virtual_sol = args.virtual_sol;
        pool.fee_bps = args.fee_bps;
        pool.recipient_count = u8::try_from(args.recipients.len())
            .map_err(|_| error!(PoolError::InvalidRecipients))?;
        pool.recipients = [Recipient::default(); MAX_RECIPIENTS];
        for (index, recipient) in args.recipients.iter().enumerate() {
            pool.recipients[index] = Recipient {
                address: recipient.address,
                weight_bps: recipient.weight_bps,
                paid: 0,
            };
        }
        pool.token_reserve = 0;
        pool.sol_reserve = 0;
        pool.fees_earned = 0;
        pool.sequence = 0;
        pool.name = args.name;
        pool.symbol = args.symbol;
        pool.uri = args.uri;
        pool.content_hash = args.content_hash;
        emit!(Prepared {
            pool: pool.key(),
            creator: pool.creator,
            nonce: pool.nonce
        });
        Ok(())
    }

    pub fn activate_launch(ctx: Context<ActivateLaunch>) -> Result<()> {
        require!(
            ctx.accounts.pool.status == PREPARED,
            PoolError::InvalidStatus
        );
        verify_immutable(
            &ctx.accounts.executable.to_account_info(),
            &ctx.accounts.program_data.to_account_info(),
        )?;
        let pool_key = ctx.accounts.pool.key();
        let authority_bump = [ctx.bumps.mint_authority];
        let authority_seeds: &[&[u8]] = &[b"mint-authority", pool_key.as_ref(), &authority_bump];
        let signers = &[authority_seeds];
        require!(
            ctx.accounts.mint.supply == 0 && ctx.accounts.mint.decimals == DECIMALS,
            PoolError::InvalidMint
        );
        require!(
            ctx.accounts.mint.mint_authority == COption::Some(ctx.accounts.mint_authority.key())
                && ctx.accounts.mint.freeze_authority == COption::None,
            PoolError::InvalidMint
        );
        validate_token_vault(
            &ctx.accounts.token_vault,
            &pool_key,
            &ctx.accounts.mint.key(),
        )?;
        require!(
            ctx.accounts.token_vault.amount == 0,
            PoolError::InvalidVault
        );
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                signers,
            ),
            SUPPLY,
        )?;
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.mint_authority.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                signers,
            ),
            AuthorityType::MintTokens,
            None,
        )?;
        ctx.accounts.mint.reload()?;
        ctx.accounts.token_vault.reload()?;
        require!(
            ctx.accounts.mint.supply == SUPPLY
                && ctx.accounts.mint.mint_authority == COption::None
                && ctx.accounts.mint.freeze_authority == COption::None,
            PoolError::InvalidMint
        );
        require!(
            ctx.accounts.token_vault.amount == SUPPLY,
            PoolError::InvalidVault
        );
        validate_token_vault(
            &ctx.accounts.token_vault,
            &pool_key,
            &ctx.accounts.mint.key(),
        )?;
        let rent_floor = ctx.accounts.rent.minimum_balance(SolVault::SPACE);
        ctx.accounts.reserve.set_inner(SolVault {
            pool: pool_key,
            kind: 0,
            rent_floor,
        });
        ctx.accounts.fees.set_inner(SolVault {
            pool: pool_key,
            kind: 1,
            rent_floor,
        });
        ctx.accounts.pool.token_reserve = SUPPLY;
        ctx.accounts.pool.status = ACTIVE;
        check_sol_coverage(&ctx.accounts.reserve, 0)?;
        check_sol_coverage(&ctx.accounts.fees, 0)?;
        emit!(Activated {
            pool: pool_key,
            mint: ctx.accounts.mint.key(),
            supply: SUPPLY
        });
        Ok(())
    }

    pub fn cancel_preparation(ctx: Context<CancelPreparation>) -> Result<()> {
        require!(
            ctx.accounts.pool.status == PREPARED,
            PoolError::InvalidStatus
        );
        // Never close: the permanent tombstone consumes this creator/nonce.
        ctx.accounts.pool.status = CANCELLED;
        emit!(Cancelled {
            pool: ctx.accounts.pool.key()
        });
        Ok(())
    }

    pub fn buy_exact_in(
        ctx: Context<Trade>,
        amount_in: u64,
        minimum_out: u64,
        expiry_slot: u64,
    ) -> Result<()> {
        let slot = validate_trade(ctx.accounts, expiry_slot)?;
        let pool = &ctx.accounts.pool;
        let quote = math::buy(
            pool.token_reserve,
            pool.sol_reserve,
            pool.virtual_sol,
            pool.fee_bps,
            amount_in,
        )?;
        require!(quote.amount_out >= minimum_out, PoolError::Slippage);
        let next_fees = pool
            .fees_earned
            .checked_add(u128::from(quote.fee))
            .ok_or(PoolError::Arithmetic)?;
        let next_sequence = pool.sequence.checked_add(1).ok_or(PoolError::Arithmetic)?;
        sol_transfer(
            &ctx.accounts.system_program,
            &ctx.accounts.trader.to_account_info(),
            &ctx.accounts.reserve.to_account_info(),
            amount_in - quote.fee,
        )?;
        sol_transfer(
            &ctx.accounts.system_program,
            &ctx.accounts.trader.to_account_info(),
            &ctx.accounts.fees.to_account_info(),
            quote.fee,
        )?;
        let nonce = pool.nonce.to_le_bytes();
        let bump = [pool.bump];
        let seeds: &[&[u8]] = &[b"pool", pool.creator.as_ref(), &nonce, &bump];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.trader_token.to_account_info(),
                    authority: pool.to_account_info(),
                },
                &[seeds],
            ),
            quote.amount_out,
            DECIMALS,
        )?;
        apply_trade(&mut ctx.accounts.pool, &quote, next_fees, next_sequence);
        ctx.accounts.token_vault.reload()?;
        validate_balances(ctx.accounts)?;
        emit!(Swap {
            pool: ctx.accounts.pool.key(),
            trader: ctx.accounts.trader.key(),
            sequence: next_sequence,
            is_buy: true,
            amount_in,
            amount_out: quote.amount_out,
            fee: quote.fee,
            token_reserve: quote.token_reserve,
            sol_reserve: quote.sol_reserve,
            slot
        });
        Ok(())
    }

    pub fn sell_exact_in(
        ctx: Context<Trade>,
        amount_in: u64,
        minimum_out: u64,
        expiry_slot: u64,
    ) -> Result<()> {
        let slot = validate_trade(ctx.accounts, expiry_slot)?;
        let pool = &ctx.accounts.pool;
        let quote = math::sell(
            pool.token_reserve,
            pool.sol_reserve,
            pool.virtual_sol,
            pool.fee_bps,
            amount_in,
        )?;
        require!(quote.amount_out >= minimum_out, PoolError::Slippage);
        let next_fees = pool
            .fees_earned
            .checked_add(u128::from(quote.fee))
            .ok_or(PoolError::Arithmetic)?;
        let next_sequence = pool.sequence.checked_add(1).ok_or(PoolError::Arithmetic)?;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.trader_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            amount_in,
            DECIMALS,
        )?;
        move_owned_lamports(
            &ctx.accounts.reserve.to_account_info(),
            &ctx.accounts.trader.to_account_info(),
            quote.amount_out,
        )?;
        move_owned_lamports(
            &ctx.accounts.reserve.to_account_info(),
            &ctx.accounts.fees.to_account_info(),
            quote.fee,
        )?;
        apply_trade(&mut ctx.accounts.pool, &quote, next_fees, next_sequence);
        ctx.accounts.token_vault.reload()?;
        validate_balances(ctx.accounts)?;
        emit!(Swap {
            pool: ctx.accounts.pool.key(),
            trader: ctx.accounts.trader.key(),
            sequence: next_sequence,
            is_buy: false,
            amount_in,
            amount_out: quote.amount_out,
            fee: quote.fee,
            token_reserve: quote.token_reserve,
            sol_reserve: quote.sol_reserve,
            slot
        });
        Ok(())
    }

    pub fn claim_fees(ctx: Context<ClaimFees>, recipient_index: u8) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == ACTIVE, PoolError::InvalidStatus);
        let index = usize::from(recipient_index);
        require!(
            index < usize::from(pool.recipient_count),
            PoolError::InvalidRecipients
        );
        let recipient = pool.recipients[index];
        require_keys_eq!(
            recipient.address,
            ctx.accounts.recipient.key(),
            PoolError::InvalidRecipients
        );
        require!(
            !ctx.accounts.recipient.executable && ctx.accounts.recipient.owner != &crate::ID,
            PoolError::InvalidRecipients
        );
        check_sol_coverage(&ctx.accounts.fees, pool.fee_liability()?)?;
        let entitled = math::entitlement(pool.fees_earned, recipient.weight_bps)?;
        let amount = u64::try_from(
            entitled
                .checked_sub(recipient.paid)
                .ok_or(PoolError::Arithmetic)?,
        )
        .map_err(|_| error!(PoolError::Arithmetic))?;
        require!(amount > 0, PoolError::ZeroAmount);
        move_owned_lamports(
            &ctx.accounts.fees.to_account_info(),
            &ctx.accounts.recipient.to_account_info(),
            amount,
        )?;
        pool.recipients[index].paid = entitled;
        check_sol_coverage(&ctx.accounts.fees, pool.fee_liability()?)?;
        emit!(FeesClaimed {
            pool: pool.key(),
            recipient: recipient.address,
            amount,
            cumulative_paid: entitled
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PrepareArgs {
    pub nonce: u64,
    pub virtual_sol: u64,
    pub fee_bps: u16,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub content_hash: [u8; 32],
    pub recipients: Vec<RecipientInput>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RecipientInput {
    pub address: Pubkey,
    pub weight_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Recipient {
    pub address: Pubkey,
    pub weight_bps: u16,
    pub paid: u128,
}

#[account]
pub struct Pool {
    pub version: u8,
    pub status: u8,
    pub bump: u8,
    pub nonce: u64,
    pub creator: Pubkey,
    pub rent_payer: Pubkey,
    pub mint: Pubkey,
    pub virtual_sol: u64,
    pub fee_bps: u16,
    pub recipient_count: u8,
    pub recipients: [Recipient; MAX_RECIPIENTS],
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub fees_earned: u128,
    pub sequence: u64,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    pub content_hash: [u8; 32],
}

impl Pool {
    pub const SPACE: usize =
        8 + 3 + 8 + 96 + 8 + 2 + 1 + 7 * 50 + 16 + 16 + 8 + 12 + 32 + 10 + 200 + 32;
    pub fn fee_liability(&self) -> Result<u128> {
        require!(
            usize::from(self.recipient_count) <= MAX_RECIPIENTS,
            PoolError::InvalidRecipients
        );
        let mut paid = 0u128;
        for r in &self.recipients[..usize::from(self.recipient_count)] {
            paid = paid.checked_add(r.paid).ok_or(PoolError::Arithmetic)?;
        }
        self.fees_earned
            .checked_sub(paid)
            .ok_or_else(|| error!(PoolError::Arithmetic))
    }
}

#[account]
pub struct SolVault {
    pub pool: Pubkey,
    pub kind: u8,
    pub rent_floor: u64,
}
impl SolVault {
    pub const SPACE: usize = 8 + 32 + 1 + 8;
}

#[derive(Accounts)]
#[instruction(args: PrepareArgs)]
pub struct PrepareLaunch<'info> {
    pub creator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = Pool::SPACE, seeds = [b"pool", creator.key().as_ref(), &args.nonce.to_le_bytes()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ActivateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.nonce.to_le_bytes()], bump = pool.bump, has_one = creator, constraint = pool.version == 1 @ PoolError::InvalidVersion, constraint = pool.status == PREPARED @ PoolError::InvalidStatus)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = creator, seeds = [b"mint", pool.key().as_ref()], bump, mint::decimals = DECIMALS, mint::authority = mint_authority)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(init, payer = creator, seeds = [b"token", pool.key().as_ref()], bump, token::mint = mint, token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = creator, space = SolVault::SPACE, seeds = [b"reserve", pool.key().as_ref()], bump)]
    pub reserve: Box<Account<'info, SolVault>>,
    #[account(init, payer = creator, space = SolVault::SPACE, seeds = [b"fees", pool.key().as_ref()], bump)]
    pub fees: Box<Account<'info, SolVault>>,
    /// CHECK: only this seed-derived temporary authority can mint during activation.
    #[account(seeds = [b"mint-authority", pool.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: exact executable and loader linkage are checked in verify_immutable.
    pub executable: UncheckedAccount<'info>,
    /// CHECK: exact linked ProgramData and revoked authority checked in verify_immutable.
    pub program_data: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CancelPreparation<'info> {
    pub creator: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.nonce.to_le_bytes()], bump = pool.bump, has_one = creator, constraint = pool.version == 1 @ PoolError::InvalidVersion)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.nonce.to_le_bytes()], bump = pool.bump, has_one = mint, constraint = pool.version == 1 @ PoolError::InvalidVersion, constraint = pool.status == ACTIVE @ PoolError::InvalidStatus)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [b"mint", pool.key().as_ref()], bump)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, seeds = [b"token", pool.key().as_ref()], bump, token::mint = mint, token::authority = pool)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"reserve", pool.key().as_ref()], bump, has_one = pool, constraint = reserve.kind == 0 @ PoolError::InvalidVault)]
    pub reserve: Box<Account<'info, SolVault>>,
    #[account(mut, seeds = [b"fees", pool.key().as_ref()], bump, has_one = pool, constraint = fees.kind == 1 @ PoolError::InvalidVault)]
    pub fees: Box<Account<'info, SolVault>>,
    #[account(mut, token::mint = mint, token::authority = trader, constraint = trader_token.key() != token_vault.key() @ PoolError::AccountAlias)]
    pub trader_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(mut, seeds = [b"pool", pool.creator.as_ref(), &pool.nonce.to_le_bytes()], bump = pool.bump, constraint = pool.version == 1 @ PoolError::InvalidVersion)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [b"fees", pool.key().as_ref()], bump, has_one = pool, constraint = fees.kind == 1 @ PoolError::InvalidVault)]
    pub fees: Box<Account<'info, SolVault>>,
    /// CHECK: only the fixed stored recipient is accepted; never a caller-selected payout.
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,
}

pub fn validate_terms(args: &PrepareArgs, pool: &Pubkey) -> Result<()> {
    require!(
        (MIN_VIRTUAL_SOL..=MAX_VIRTUAL_SOL).contains(&args.virtual_sol),
        PoolError::InvalidVirtualSol
    );
    require!(matches!(args.fee_bps, 0 | 100 | 300), PoolError::InvalidFee);
    require!(
        !args.name.trim().is_empty()
            && args.name.len() <= 32
            && !args.name.chars().any(char::is_control),
        PoolError::InvalidMetadata
    );
    require!(
        !args.symbol.trim().is_empty()
            && args.symbol.len() <= 10
            && !args.symbol.chars().any(char::is_control),
        PoolError::InvalidMetadata
    );
    require!(
        args.uri.len() <= 200 && !args.uri.chars().any(char::is_control),
        PoolError::InvalidMetadata
    );
    if args.fee_bps == 0 {
        require!(args.recipients.is_empty(), PoolError::InvalidRecipients);
        return Ok(());
    }
    require!(
        !args.recipients.is_empty() && args.recipients.len() <= MAX_RECIPIENTS,
        PoolError::InvalidRecipients
    );
    let aliases: Vec<Pubkey> = [
        b"mint".as_slice(),
        b"token",
        b"reserve",
        b"fees",
        b"mint-authority",
    ]
    .iter()
    .map(|seed| Pubkey::find_program_address(&[seed, pool.as_ref()], &crate::ID).0)
    .collect();
    let mut sum = 0u32;
    for (i, r) in args.recipients.iter().enumerate() {
        require!(
            r.address != Pubkey::default()
                && r.address != *pool
                && !aliases.contains(&r.address)
                && r.address != crate::ID,
            PoolError::InvalidRecipients
        );
        require!(
            r.weight_bps > 0
                && r.weight_bps <= 10_000
                && !args.recipients[..i]
                    .iter()
                    .any(|other| other.address == r.address),
            PoolError::InvalidRecipients
        );
        sum = sum
            .checked_add(u32::from(r.weight_bps))
            .ok_or(PoolError::Arithmetic)?;
    }
    require!(sum == 10_000, PoolError::InvalidRecipients);
    Ok(())
}

pub fn verify_immutable(executable: &AccountInfo, program_data: &AccountInfo) -> Result<()> {
    require_keys_eq!(*executable.key, crate::ID, PoolError::MutableProgram);
    require!(
        executable.executable
            && executable.owner == &bpf_loader_upgradeable::ID
            && program_data.owner == &bpf_loader_upgradeable::ID,
        PoolError::MutableProgram
    );
    let expected_data =
        Pubkey::find_program_address(&[crate::ID.as_ref()], &bpf_loader_upgradeable::ID).0;
    require_keys_eq!(*program_data.key, expected_data, PoolError::MutableProgram);
    let code_data = executable.try_borrow_data()?;
    require!(code_data.len() == 36, PoolError::MutableProgram);
    let state: bpf_loader_upgradeable::UpgradeableLoaderState =
        bincode::deserialize(&code_data).map_err(|_| error!(PoolError::MutableProgram))?;
    match state {
        bpf_loader_upgradeable::UpgradeableLoaderState::Program {
            programdata_address,
        } => require_keys_eq!(
            programdata_address,
            expected_data,
            PoolError::MutableProgram
        ),
        _ => return err!(PoolError::MutableProgram),
    }
    let data = program_data.try_borrow_data()?;
    require!(data.len() >= 45, PoolError::MutableProgram);
    let state: bpf_loader_upgradeable::UpgradeableLoaderState =
        bincode::deserialize(&data).map_err(|_| error!(PoolError::MutableProgram))?;
    match state {
        bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: None,
            ..
        } => Ok(()),
        _ => err!(PoolError::MutableProgram),
    }
}

fn validate_token_vault(vault: &TokenAccount, pool: &Pubkey, mint: &Pubkey) -> Result<()> {
    require!(
        vault.owner == *pool
            && vault.mint == *mint
            && vault.delegate == COption::None
            && vault.close_authority == COption::None
            && vault.is_native == COption::None,
        PoolError::InvalidVault
    );
    Ok(())
}
fn check_sol_coverage(vault: &Account<SolVault>, liability: u128) -> Result<()> {
    let needed = liability
        .checked_add(u128::from(vault.rent_floor))
        .ok_or(PoolError::Arithmetic)?;
    require!(
        u128::from(vault.to_account_info().lamports()) >= needed,
        PoolError::Insolvent
    );
    Ok(())
}
fn validate_balances(accounts: &Trade) -> Result<()> {
    require!(
        accounts.token_vault.amount >= accounts.pool.token_reserve,
        PoolError::Insolvent
    );
    check_sol_coverage(&accounts.reserve, u128::from(accounts.pool.sol_reserve))?;
    check_sol_coverage(&accounts.fees, accounts.pool.fee_liability()?)?;
    Ok(())
}
fn validate_trade(accounts: &Trade, expiry_slot: u64) -> Result<u64> {
    let slot = Clock::get()?.slot;
    require!(slot <= expiry_slot, PoolError::Expired);
    require!(
        accounts.trader.owner != &crate::ID && !accounts.trader.executable,
        PoolError::AccountAlias
    );
    require!(
        accounts.mint.mint_authority == COption::None
            && accounts.mint.freeze_authority == COption::None
            && accounts.mint.decimals == DECIMALS
            && accounts.mint.supply <= SUPPLY,
        PoolError::InvalidMint
    );
    validate_token_vault(
        &accounts.token_vault,
        &accounts.pool.key(),
        &accounts.mint.key(),
    )?;
    validate_balances(accounts)?;
    Ok(slot)
}
fn apply_trade(pool: &mut Account<Pool>, quote: &math::Quote, fees: u128, sequence: u64) {
    pool.token_reserve = quote.token_reserve;
    pool.sol_reserve = quote.sol_reserve;
    pool.fees_earned = fees;
    pool.sequence = sequence;
}
fn sol_transfer<'info>(
    program: &Program<'info, System>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount > 0 {
        system_program::transfer(
            CpiContext::new(
                program.to_account_info(),
                SolTransfer {
                    from: from.clone(),
                    to: to.clone(),
                },
            ),
            amount,
        )?;
    }
    Ok(())
}
fn move_owned_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    require!(
        from.owner == &crate::ID && from.key != to.key,
        PoolError::AccountAlias
    );
    let remaining = from
        .lamports()
        .checked_sub(amount)
        .ok_or(PoolError::Insolvent)?;
    let received = to
        .lamports()
        .checked_add(amount)
        .ok_or(PoolError::Arithmetic)?;
    **from.try_borrow_mut_lamports()? = remaining;
    **to.try_borrow_mut_lamports()? = received;
    Ok(())
}

#[event]
pub struct Prepared {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub nonce: u64,
}
#[event]
pub struct Activated {
    pub pool: Pubkey,
    pub mint: Pubkey,
    pub supply: u64,
}
#[event]
pub struct Cancelled {
    pub pool: Pubkey,
}
#[event]
pub struct Swap {
    pub pool: Pubkey,
    pub trader: Pubkey,
    pub sequence: u64,
    pub is_buy: bool,
    pub amount_in: u64,
    pub amount_out: u64,
    pub fee: u64,
    pub token_reserve: u64,
    pub sol_reserve: u64,
    pub slot: u64,
}
#[event]
pub struct FeesClaimed {
    pub pool: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub cumulative_paid: u128,
}

#[error_code]
pub enum PoolError {
    #[msg("Arithmetic limit exceeded")]
    Arithmetic,
    #[msg("Invalid immutable fee tier")]
    InvalidFee,
    #[msg("Invalid fixed recipients")]
    InvalidRecipients,
    #[msg("Invalid token inventory")]
    InvalidInventory,
    #[msg("Virtual SOL is outside the supported range")]
    InvalidVirtualSol,
    #[msg("Actual reserves do not cover accounted obligations")]
    Insolvent,
    #[msg("Trade or claim amount rounds to zero")]
    ZeroAmount,
    #[msg("Operation is not allowed in this pool state")]
    InvalidStatus,
    #[msg("Invalid mint authority, supply, or decimals")]
    InvalidMint,
    #[msg("Invalid custody vault")]
    InvalidVault,
    #[msg("Minimum output not met")]
    Slippage,
    #[msg("Protocol account aliases are not permitted")]
    AccountAlias,
    #[msg("Unsupported pool version")]
    InvalidVersion,
    #[msg("Invalid or oversized metadata")]
    InvalidMetadata,
    #[msg("Activation requires this exact program to be immutable")]
    MutableProgram,
    #[msg("Quote expired at its maximum slot")]
    Expired,
}

#[cfg(test)]
mod tests;
