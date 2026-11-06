# Launch pool ABI v1

Unreleased, no mainnet program ID. Anchor 0.31.1 Borsh encoding. All integers little endian. Instruction discriminator: first 8 bytes of SHA-256 `global:<snake_case_name>`; account discriminator: first 8 bytes of SHA-256 `account:<RustName>`.

Seeds: pool `["pool", creator(32), nonce(u64 LE)]`; mint `["mint", pool]`; token vault `["token", pool]`; reserve `["reserve", pool]`; fees `["fees", pool]`; temporary mint authority `["mint-authority", pool]`. Every PDA is scoped to the configured program ID.

## Instructions

Accounts in exact order, `w` writable, `s` signer. System is `11111111111111111111111111111111`; token is legacy SPL only. `programData` must be linked by this program executable.

- `prepare_launch(args: PrepareArgs)`: creator(s), payer(ws), pool(w), systemProgram. Args: nonce u64; virtualSol u64; feeBps u16; name string; symbol string; uri string; contentHash [u8;32]; recipients Vec<RecipientInput>. RecipientInput: address Pubkey, weightBps u16.
- `activate_launch()`: creator(ws), pool(w), mint(w), tokenVault(w), reserve(w), fees(w), mintAuthority, executable, programData, tokenProgram, systemProgram, rent. Creator pays activation rent.
- `cancel_preparation()`: creator(s), pool(w). Retains full preparation as permanent cancelled tombstone. No refund because preparation has no auxiliary accounts.
- `buy_exact_in(amountIn:u64, minimumOut:u64, expirySlot:u64)`: trader(ws), pool(w), mint, tokenVault(w), reserve(w), fees(w), traderToken(w), tokenProgram, systemProgram. Trader token account must exist and have correct mint/owner. SDK may prepend ATA creation.
- `sell_exact_in(amountIn:u64, minimumOut:u64, expirySlot:u64)`: same account order as buy. Shared ABI retains systemProgram.
- `claim_fees(recipientIndex:u8)`: pool(w), fees(w), recipient(w). Permissionless; recipient must exactly match immutable entry.

## Accounts

`Pool` fields after 8-byte discriminator:

```
version u8 (=1)
status u8 (0 Prepared, 1 Active, 2 Cancelled)
bump u8
nonce u64
creator Pubkey
rentPayer Pubkey
mint Pubkey
virtualSol u64
feeBps u16
recipientCount u8
recipients [Recipient;7]
tokenReserve u64
solReserve u64
feesEarned u128
sequence u64
name string
symbol string
uri string
contentHash [u8;32]
```

`Recipient`: address Pubkey, weightBps u16, paid u128. Unused entries all zero.

`SolVault`: pool Pubkey, kind u8 (0 reserve, 1 fees), rentFloor u64 after 8-byte discriminator. Size 49 bytes.

Maximum UTF-8 bytes: name 32, symbol 10, URI 200. Original supply 1,000,000,000,000,000 atoms; decimals 6. Virtual offset 1,000,000,000 through 1,000,000,000,000,000 lamports inclusive. Mechanical limits, not endorsed valuations. Fees 0/100/300; nonzero fees require 1..7 unique nonzero recipients with weights totaling 10000; zero fees require no recipients.

Checked arithmetic: buy `R+V+net` fits u64; sell `R+V` fits u64; cumulative earned/paid u128. Expiry must be current slot or later. Reject zero input/output, nonpositive net, slippage, expired execution, inventory excess, and insufficient real SOL.

Events use Anchor `event:<Name>` discriminator. `Prepared`: pool, creator, nonce. `Activated`: pool, mint, supply. `Cancelled`: pool. `Swap`: pool Pubkey, trader Pubkey, sequence u64, isBuy bool, amountIn u64, amountOut u64, fee u64, tokenReserve u64, solReserve u64, slot u64. `FeesClaimed`: pool Pubkey, recipient Pubkey, amount u64, cumulativePaid u128. Verify successful transaction origin and reconcile account state; events alone are not evidence of origin.
