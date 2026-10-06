import type { ChartPool } from "@/lib/launchpad/chart-pool";

// Public pool identities verified against Openlaunch's API: Base/Robinhood on
// September 13, 2026; Arc on September 16, 2026.
// Market data is fetched at request time; no synthetic prices or candles.
export const REVIEW_POOLS: (ChartPool & { id: string; name: string; symbol: string; launchedAt: string; hasTrades?: boolean })[] = [
  { id: "solv", name: "SolvScore", symbol: "SOLV", chain: "base", token: "0x9aee340b42365372b525f075e60672d8fe375655", poolId: "0x554921d5edbe82d5799488ef0ccef42f527bf0951643c0eb43b4f046b4d2abd4", quote: "0x0000000000000000000000000000000000000000", launchedAt: "2026-09-11T19:03:07Z" },
  { id: "rfly", name: "RFLY", symbol: "RFLY", chain: "robinhood", token: "0x8f4a550011964ca31c4633dd914c5c66c7cbe989", poolId: "0x50f63d4d4d145e43b7a6e3b198f4e2f6a00f942c6ed822bbb525921c4b3bf4b6", quote: "0x0000000000000000000000000000000000000000", launchedAt: "2026-09-11T23:50:04Z" },
  { id: "ocat", name: "opencat", symbol: "OCAT", chain: "arc", token: "0xf21faee473897fd99ad1a8c56024efc8ffb97635", poolId: "0x0ca4514e648957422315f458df1a13d3a27ad57a8a375a340877b0dfe8616b34", quote: "0x3600000000000000000000000000000000000000", launchedAt: "2026-09-16T13:57:51Z" },
  { id: "sky", name: "Clear sky", symbol: "SKY", chain: "base", token: "0xf9473202c0766b11f879806099d5e260b3e1a250", poolId: "0x4ed5e6961940362b520ba9e1c97239a12f62c4b49c4c21598cd807b04a74d75b", quote: "0x0000000000000000000000000000000000000000", launchedAt: "2026-09-07T12:12:07Z" },
  { id: "quiver", name: "Quiver RH", symbol: "QUIVER", chain: "robinhood", token: "0x5d4a3ed0f20d5b73f88d6ebf21b45c6cd4835655", poolId: "0x1c33b20faa470ac1bf8d4d33e875ce56c3ac8854a24ac72e4f1160ce7522c6e7", quote: "0x232b8ed6377be97813853b0ac104c4cda8378d1b", launchedAt: "2026-09-07T03:48:11Z" },
  { id: "unpriced", name: "No USD price", symbol: "SKY", chain: "base", token: "0x6a22012a216250723ced7eba9f13fe8b60e5fea5", poolId: "0x767d79e5c65b85273b9d989d9303e54a119db6fbb7aeb06acac48cbc034e4909", quote: "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3", launchedAt: "2026-09-08T09:53:19Z" },
  { id: "inverted", name: "Reversed listing", symbol: "LJB", chain: "robinhood", token: "0xf0c81b03a33463272a5466afaed628989a030f82", poolId: "0x0ad3c579eee0c348603e8a5c0b81f590c5d489ae16b153812b05996da730a7b4", quote: "0xd1b0d44e4f6ed940fcc7a9f59bf30daf62ccfe3d", launchedAt: "2026-09-11T20:00:27Z" },
  { id: "new", name: "No trades", symbol: "FLY", chain: "robinhood", token: "0xbc57a682e0c44c9f27da6f41d6d5986569a76685", poolId: "0xae5cc300cde30a853a86a57e0ac6d9fc5eab25a21f00ae984e6fbf3db95f810f", quote: "0x0000000000000000000000000000000000000000", launchedAt: "2026-09-12T15:46:36Z", hasTrades: false },
];
