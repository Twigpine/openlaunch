/**
 * The slice of a Morpho Vault V2 the Earn feature calls. Vault V2 is ERC-4626 for deposit / withdraw / redeem / previews;
 * fees and gates are its own getters. Hand-written on purpose: no SDK, nothing else reachable.
 * Note: Vault V2's maxDeposit / maxWithdraw always return 0, so limits come from balances and a simulation, never from them.
 */
const gate = (name: string) => ({ type: "function", name, stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }) as const;

export const EARN_VAULT_ABI = [
  { type: "function", name: "asset", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "previewDeposit", stateMutability: "view", inputs: [{ name: "assets", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "previewRedeem", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] },
  /** WAD (1e18 = 100%) of the interest earned. */
  { type: "function", name: "performanceFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint96" }] },
  /** WAD per second of assets under management. */
  { type: "function", name: "managementFee", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint96" }] },
  gate("receiveSharesGate"),
  gate("sendSharesGate"),
  gate("receiveAssetsGate"),
  gate("sendAssetsGate"),
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "onBehalf", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "onBehalf", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "onBehalf", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

/** The four Vault V2 gates. Any one set to a non-zero address means the vault restricts who may use it. */
export const VAULT_GATES = ["receiveSharesGate", "sendSharesGate", "receiveAssetsGate", "sendAssetsGate"] as const;

export const VAULT_V2_FACTORY_ABI = [
  { type: "function", name: "isVaultV2", stateMutability: "view", inputs: [{ name: "vault", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const;
