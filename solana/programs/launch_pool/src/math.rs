//! Original checked integer curve and cumulative fee arithmetic. No floating point.
use crate::PoolError;
use anchor_lang::prelude::*;

pub const SUPPLY: u64 = 1_000_000_000_000_000;
pub const DECIMALS: u8 = 6;
pub const MIN_VIRTUAL_SOL: u64 = 1_000_000_000;
pub const MAX_VIRTUAL_SOL: u64 = 1_000_000_000_000_000;
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quote {
    pub amount_out: u64,
    pub fee: u64,
    pub token_reserve: u64,
    pub sol_reserve: u64,
}

pub fn fee(amount: u64, fee_bps: u16) -> Result<u64> {
    require!(matches!(fee_bps, 0 | 100 | 300), PoolError::InvalidFee);
    let product = u128::from(amount) * u128::from(fee_bps);
    let result = product / BPS + u128::from(product % BPS != 0);
    u64::try_from(result).map_err(|_| error!(PoolError::Arithmetic))
}

pub fn entitlement(earned: u128, weight: u16) -> Result<u128> {
    require!(weight > 0 && weight <= 10_000, PoolError::InvalidRecipients);
    // Decompose before multiplying: the result never exceeds earned, even at u128::MAX.
    (earned / BPS)
        .checked_mul(u128::from(weight))
        .and_then(|n| n.checked_add((earned % BPS) * u128::from(weight) / BPS))
        .ok_or_else(|| error!(PoolError::Arithmetic))
}

pub fn invariant(x: u64, r: u64, v: u64) -> Result<()> {
    require!(x > 0 && x <= SUPPLY, PoolError::InvalidInventory);
    require!(
        (MIN_VIRTUAL_SOL..=MAX_VIRTUAL_SOL).contains(&v),
        PoolError::InvalidVirtualSol
    );
    let total = r.checked_add(v).ok_or(PoolError::Arithmetic)?;
    require!(
        u128::from(x) * u128::from(total) >= u128::from(SUPPLY) * u128::from(v),
        PoolError::Insolvent
    );
    Ok(())
}

pub fn buy(x: u64, r: u64, v: u64, fee_bps: u16, input: u64) -> Result<Quote> {
    invariant(x, r, v)?;
    require!(input > 0, PoolError::ZeroAmount);
    let fee = fee(input, fee_bps)?;
    let net = input.checked_sub(fee).ok_or(PoolError::Arithmetic)?;
    require!(net > 0, PoolError::ZeroAmount);
    let denominator = r
        .checked_add(v)
        .and_then(|n| n.checked_add(net))
        .ok_or(PoolError::Arithmetic)?;
    let out = u64::try_from(u128::from(x) * u128::from(net) / u128::from(denominator))
        .map_err(|_| error!(PoolError::Arithmetic))?;
    require!(out > 0 && out < x, PoolError::ZeroAmount);
    let next = Quote {
        amount_out: out,
        fee,
        token_reserve: x - out,
        sol_reserve: r.checked_add(net).ok_or(PoolError::Arithmetic)?,
    };
    invariant(next.token_reserve, next.sol_reserve, v)?;
    Ok(next)
}

pub fn sell(x: u64, r: u64, v: u64, fee_bps: u16, input: u64) -> Result<Quote> {
    invariant(x, r, v)?;
    require!(
        input > 0 && input <= SUPPLY - x,
        PoolError::InvalidInventory
    );
    let total = r.checked_add(v).ok_or(PoolError::Arithmetic)?;
    let next_x = x.checked_add(input).ok_or(PoolError::Arithmetic)?;
    let gross = u64::try_from(u128::from(total) * u128::from(input) / u128::from(next_x))
        .map_err(|_| error!(PoolError::Arithmetic))?;
    require!(gross <= r, PoolError::Insolvent);
    let fee = fee(gross, fee_bps)?;
    let out = gross.checked_sub(fee).ok_or(PoolError::Arithmetic)?;
    require!(out > 0, PoolError::ZeroAmount);
    let next = Quote {
        amount_out: out,
        fee,
        token_reserve: next_x,
        sol_reserve: r - gross,
    };
    invariant(next.token_reserve, next.sol_reserve, v)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn published_round_trip() {
        let a = buy(SUPPLY, 0, 30_000_000_000, 100, 1_000_000_000).unwrap();
        assert_eq!(a.amount_out, 31_945_788_964_181);
        assert_eq!(a.fee, 10_000_000);
        let b = sell(
            a.token_reserve,
            a.sol_reserve,
            30_000_000_000,
            100,
            a.amount_out,
        )
        .unwrap();
        assert_eq!(b.amount_out, 980_099_999);
        assert_eq!(b.sol_reserve, 1);
    }
    #[test]
    fn ceilings_and_lifetime_boundaries() {
        assert_eq!(fee(1, 100).unwrap(), 1);
        assert_eq!(fee(u64::MAX, 300).unwrap(), 553_402_322_211_286_549);
        assert_eq!(entitlement(u128::MAX, 10_000).unwrap(), u128::MAX);
        let allocated = [3333, 3333, 3334]
            .iter()
            .map(|w| entitlement(u128::MAX, *w).unwrap())
            .sum::<u128>();
        assert!(u128::MAX - allocated < 3);
        assert!(fee(10, 101).is_err());
        assert!(entitlement(100, 0).is_err());
    }
    #[test]
    fn rejects_extreme_invalid_states() {
        assert!(buy(SUPPLY, 0, MIN_VIRTUAL_SOL, 0, u64::MAX).is_err());
        assert!(buy(0, 0, MIN_VIRTUAL_SOL, 0, 1).is_err());
        assert!(buy(SUPPLY, 0, MIN_VIRTUAL_SOL - 1, 0, 1).is_err());
        assert!(buy(SUPPLY, 0, MIN_VIRTUAL_SOL, 100, 1).is_err());
        assert!(sell(SUPPLY, 0, MIN_VIRTUAL_SOL, 0, 1).is_err());
        assert!(sell(SUPPLY - 100, 0, MIN_VIRTUAL_SOL, 0, 1).is_err());
    }
    #[test]
    fn randomized_conservation_and_round_trips() {
        let mut seed = 29103u64;
        for rate in [0, 100, 300] {
            for v in [MIN_VIRTUAL_SOL, 30_000_000_000, MAX_VIRTUAL_SOL] {
                let (mut x, mut r, mut circulating, mut paid_in, mut paid_out, mut fees) =
                    (SUPPLY, 0u64, 0u64, 0u128, 0u128, 0u128);
                for _ in 0..12_000 {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    if circulating == 0 || seed & 1 == 0 {
                        let input = seed % 1_000_000_000 + 1;
                        if let Ok(q) = buy(x, r, v, rate, input) {
                            let reverse =
                                sell(q.token_reserve, q.sol_reserve, v, rate, q.amount_out);
                            if let Ok(reverse) = reverse {
                                assert!(reverse.amount_out <= input);
                            }
                            paid_in += u128::from(input);
                            circulating += q.amount_out;
                            fees += u128::from(q.fee);
                            x = q.token_reserve;
                            r = q.sol_reserve;
                        }
                    } else {
                        let input = seed % circulating + 1;
                        if let Ok(q) = sell(x, r, v, rate, input) {
                            paid_out += u128::from(q.amount_out);
                            circulating -= input;
                            fees += u128::from(q.fee);
                            x = q.token_reserve;
                            r = q.sol_reserve;
                        }
                    }
                    assert_eq!(x + circulating, SUPPLY);
                    assert_eq!(paid_in - paid_out, u128::from(r) + fees);
                    invariant(x, r, v).unwrap();
                }
            }
        }
    }
}
