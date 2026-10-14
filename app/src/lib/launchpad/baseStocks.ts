/**
 * Coinbase tokenized stocks on Base (B20 standard) as quote assets — pure logic, node --test loads this.
 *
 * Registry = Coinbase's own list, the public Tokenized Stocks API (api.coinbase.com/v1/tokenized-stocks,
 * documented at docs.base.org/sdks/tokenized-stocks; issuer Coinbase, custodian Alpaca, Regulation S: not
 * for US/UK/CA/AU/SG/CH persons). An address is a stock here ONLY if it is in this list — never by on-chain
 * name/symbol, which anyone can fake, and never by its B20 shape, which every Base-native token has.
 * Synced 2026-10-14: the API's 145 tokens, each read back from Base (symbol and decimals match), plus COINc,
 * which the API leaves out but which exists on-chain, has a Chainlink feed and has launches quoted in it.
 * Names are the issuer's without the legal suffix ("Netflix Inc" → "Netflix"); the address is the identity.
 * Rows are sorted by underlying ticker. A stock the issuer has listed may have no supply yet.
 * This list is the floor: at run time the server also reads Coinbase's registry and adds any stock listed there that this
 * list lacks (parseBaseRegistry, mergeBaseStocks; stocksServer.ts). It only adds, so a stock never drops out of the app.
 *
 * Prices come from Chainlink's on-chain "Coinbase <TICKER>" feeds on Base (8 decimals, 24/5, the
 * feed holds the last close while markets are shut) — no third-party API, no key. Chainlink publishes a
 * feed for 13 of the stocks; the rest carry `feed: null` and have no USD price until one exists (the
 * launch form then takes the starting cap in stock units).
 *
 * B20 tokens are Base-native precompiles: some RPC providers (Alchemy, at the time of writing) cannot
 * execute calls that touch them and answer "EVM error OpcodeNotFound"; `isB20RpcError` lets the RPC
 * proxy and server client retry such calls on a B20-capable node.
 */
export type BaseStock = { symbol: string; name: string; address: string; feed: string | null; decimals: number };
/** A registry stock Chainlink publishes a feed for. */
export type PricedBaseStock = BaseStock & { feed: string };

export const BASE_STOCK_DECIMALS = 8;
/** Hits per search in the launch form's picker: every stock with a price feed fits, so an empty search lists those first. */
export const BASE_STOCK_SEARCH_LIMIT = 13;
export const BASE_STOCK_ISSUER = "Coinbase";
/** Chainlink 24/5 equity feeds hold the last close over weekends/holidays; beyond this we stop trusting them. */
export const BASE_STOCK_MAX_FEED_AGE_S = 5 * 24 * 3600;
/** All B20 token addresses start with this 10-byte prefix (then 1 variant byte + 9 bytes of hash). */
export const B20_PREFIX = "0xb200000000000000000000";

export const BASE_STOCKS: readonly BaseStock[] = [
  { symbol: "AAOIc", name: "Applied Optoelectronics", address: "0xb200000000000000000000cf36d05963a3e2205c", feed: null, decimals: 8 },
  { symbol: "AAPLc", name: "Apple", address: "0xb200000000000000000000c2e324d24d7eecd1fb", feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988", decimals: 8 },
  { symbol: "AEOc", name: "American Eagle Outfitters", address: "0xb2000000000000000000006064f8ec027f042294", feed: null, decimals: 8 },
  { symbol: "AMCc", name: "AMC Entertainment Holdings", address: "0xb200000000000000000000cd7e6b8042cb7c2bb5", feed: null, decimals: 8 },
  { symbol: "AMDc", name: "Advanced Micro Devices", address: "0xb2000000000000000000000d8ce462e99ee7a47b", feed: null, decimals: 8 },
  { symbol: "AMZNc", name: "Amazon", address: "0xb200000000000000000000d9192b6b456483c2e8", feed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295", decimals: 8 },
  { symbol: "APPc", name: "AppLovin", address: "0xb20000000000000000000006f910a0e7bbd3c168", feed: null, decimals: 8 },
  { symbol: "ARMc", name: "Arm Holdings", address: "0xb20000000000000000000026215d755356e5043f", feed: null, decimals: 8 },
  { symbol: "ASTSc", name: "AST SpaceMobile", address: "0xb200000000000000000000b1a29cf17a1819288a", feed: null, decimals: 8 },
  { symbol: "AURc", name: "Aurora Innovation", address: "0xb200000000000000000000cf62d7125cc77d2f96", feed: null, decimals: 8 },
  { symbol: "AVGOc", name: "Broadcom", address: "0xb200000000000000000000fc737aea6196ab5a4c", feed: null, decimals: 8 },
  { symbol: "AXONc", name: "Axon Enterprise", address: "0xb2000000000000000000004cc3e96ceb78541d33", feed: null, decimals: 8 },
  { symbol: "AXTIc", name: "AXT", address: "0xb200000000000000000000a640ec8c1de0efb484", feed: null, decimals: 8 },
  { symbol: "BEc", name: "Bloom Energy", address: "0xb20000000000000000000016f9dfe862feba122b", feed: null, decimals: 8 },
  { symbol: "BIDUc", name: "Baidu", address: "0xb200000000000000000000d2b7d9aee52f6c6bef", feed: null, decimals: 8 },
  { symbol: "BILIc", name: "Bilibili", address: "0xb200000000000000000000ca7c6d1438e7245eb6", feed: null, decimals: 8 },
  { symbol: "BIRDc", name: "Smartbird", address: "0xb200000000000000000000535fe96f18204bfd96", feed: null, decimals: 8 },
  { symbol: "BJc", name: "BJ's Wholesale Club Holdings", address: "0xb200000000000000000000082f7fea8f2ee8f438", feed: null, decimals: 8 },
  { symbol: "BMNRc", name: "BitMine Immersion Technologies", address: "0xb200000000000000000000ea2df44a307cab279c", feed: null, decimals: 8 },
  { symbol: "BRK.Bc", name: "Berkshire Hathaway Class B", address: "0xb20000000000000000000024170488e788cbbcb4", feed: null, decimals: 8 },
  { symbol: "BUDc", name: "Anheuser-Busch InBev", address: "0xb200000000000000000000c36ce081dd09e86ca2", feed: null, decimals: 8 },
  { symbol: "BYNDc", name: "Beyond Meat", address: "0xb200000000000000000000801830b13b8e493423", feed: null, decimals: 8 },
  { symbol: "CAKEc", name: "Cheesecake Factory", address: "0xb200000000000000000000f215e4c890cfb7176b", feed: null, decimals: 8 },
  { symbol: "CANc", name: "Canaan", address: "0xb200000000000000000000f32d61ba597eddfbfd", feed: null, decimals: 8 },
  { symbol: "CAVAc", name: "CAVA Group", address: "0xb2000000000000000000001b6e407239eb31edcf", feed: null, decimals: 8 },
  { symbol: "CBRSc", name: "Cerebras Systems", address: "0xb200000000000000000000720133eedf525f93e2", feed: null, decimals: 8 },
  { symbol: "CELHc", name: "Celsius Holdings", address: "0xb2000000000000000000004161b4168d03841511", feed: null, decimals: 8 },
  { symbol: "CHWYc", name: "Chewy", address: "0xb200000000000000000000a5e12a1842dfcdb118", feed: null, decimals: 8 },
  { symbol: "CIFRc", name: "Cipher Digital", address: "0xb200000000000000000000690275843b6e246286", feed: null, decimals: 8 },
  { symbol: "CLOVc", name: "Clover Health Investments", address: "0xb20000000000000000000055e63c4c1cdc6b7a36", feed: null, decimals: 8 },
  { symbol: "CLSKc", name: "CleanSpark", address: "0xb200000000000000000000fa63cfff5c794dbb95", feed: null, decimals: 8 },
  { symbol: "COINc", name: "Coinbase", address: "0xb200000000000000000000c85a31389d71f3ecfb", feed: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7", decimals: 8 },
  { symbol: "CORZc", name: "Core Scientific", address: "0xb2000000000000000000001aaa9010cd65f82c5e", feed: null, decimals: 8 },
  { symbol: "CRCLc", name: "Circle", address: "0xb20000000000000000000019f6e7c675b73c2e4d", feed: "0x0231cF2635D1E17bB5c2462cc7504Ba1fBd61f33", decimals: 8 },
  { symbol: "CROXc", name: "Crocs", address: "0xb200000000000000000000431a5c1e48e3b1d130", feed: null, decimals: 8 },
  { symbol: "CRWVc", name: "CoreWeave", address: "0xb200000000000000000000f111184a74720787e6", feed: null, decimals: 8 },
  { symbol: "CVNAc", name: "Carvana", address: "0xb200000000000000000000ffb10718f880a48274", feed: null, decimals: 8 },
  { symbol: "DJTc", name: "Trump Media & Technology Group", address: "0xb200000000000000000000428e3a3eebbb20692b", feed: null, decimals: 8 },
  { symbol: "DUOLc", name: "Duolingo", address: "0xb200000000000000000000a613d12deafbbb1db7", feed: null, decimals: 8 },
  { symbol: "EATc", name: "Brinker International", address: "0xb200000000000000000000808e9cca9ed8e4da61", feed: null, decimals: 8 },
  { symbol: "ELFc", name: "e.l.f. Beauty", address: "0xb2000000000000000000006b7f6966ee0453e251", feed: null, decimals: 8 },
  { symbol: "FIGRc", name: "Figure Technology Solutions", address: "0xb2000000000000000000005a41bef59807119850", feed: null, decimals: 8 },
  { symbol: "FWDIc", name: "Forward Industries", address: "0xb2000000000000000000001e838d4beb66cf8fb7", feed: null, decimals: 8 },
  { symbol: "GAMEc", name: "GameSquare Holdings", address: "0xb2000000000000000000005550e8506124236271", feed: null, decimals: 8 },
  { symbol: "GEMIc", name: "Gemini Space Station", address: "0xb2000000000000000000009c52748e1d1cbd5fd6", feed: null, decimals: 8 },
  { symbol: "GLXYc", name: "Galaxy Digital", address: "0xb2000000000000000000006de7888c3fffd803ac", feed: null, decimals: 8 },
  { symbol: "GMEc", name: "GameStop", address: "0xb2000000000000000000007790ed6e48e06ed935", feed: null, decimals: 8 },
  { symbol: "GOOGLc", name: "Alphabet", address: "0xb2000000000000000000002d0ba3164cc74f58b7", feed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2", decimals: 8 },
  { symbol: "GPROc", name: "GoPro", address: "0xb200000000000000000000f0e13d9c1cdfd211c8", feed: null, decimals: 8 },
  { symbol: "HIMSc", name: "Hims & Hers Health", address: "0xb20000000000000000000043a599976181bcf336", feed: null, decimals: 8 },
  { symbol: "HPQc", name: "HP", address: "0xb2000000000000000000009a3602cf5d020afa98", feed: null, decimals: 8 },
  { symbol: "HSAIc", name: "Hesai Group", address: "0xb200000000000000000000f3049f4aa834b23b64", feed: null, decimals: 8 },
  { symbol: "HSYc", name: "The Hershey Company", address: "0xb200000000000000000000f327a373aa86ac86a8", feed: null, decimals: 8 },
  { symbol: "HTZc", name: "Hertz Global Holdings", address: "0xb2000000000000000000002601c5c94f435da168", feed: null, decimals: 8 },
  { symbol: "HUTc", name: "Hut 8", address: "0xb2000000000000000000006ee1c139a723872e09", feed: null, decimals: 8 },
  { symbol: "INFYc", name: "Infosys", address: "0xb200000000000000000000f6b0417af5f52341fc", feed: null, decimals: 8 },
  { symbol: "INTCc", name: "Intel", address: "0xb2000000000000000000004aff16039ba04bdfbc", feed: "0xAB657C39bac0D5886250D70849e2E3E008F2EECB", decimals: 8 },
  { symbol: "IONQc", name: "IonQ", address: "0xb20000000000000000000058f143099d5f79b0ec", feed: null, decimals: 8 },
  { symbol: "KODKc", name: "Eastman Kodak", address: "0xb200000000000000000000a63e35e673e3776b88", feed: null, decimals: 8 },
  { symbol: "KSSc", name: "Kohl's", address: "0xb200000000000000000000105a1f43ff3605c5de", feed: null, decimals: 8 },
  { symbol: "LCIDc", name: "Lucid Group", address: "0xb20000000000000000000081050ac3d4395df527", feed: null, decimals: 8 },
  { symbol: "LEUc", name: "Centrus Energy", address: "0xb200000000000000000000fab55ad3773f2c8ef1", feed: null, decimals: 8 },
  { symbol: "LIc", name: "Li Auto", address: "0xb200000000000000000000d61efd9f54a23ef9eb", feed: null, decimals: 8 },
  { symbol: "LITEc", name: "Lumentum Holdings", address: "0xb200000000000000000000eda6c2c6f11e0f838f", feed: null, decimals: 8 },
  { symbol: "LLYc", name: "Eli Lilly", address: "0xb200000000000000000000f1a0f91e34892e4718", feed: null, decimals: 8 },
  { symbol: "LUVc", name: "Southwest Airlines", address: "0xb200000000000000000000d5c0393796e92fcab0", feed: null, decimals: 8 },
  { symbol: "LYVc", name: "Live Nation Entertainment", address: "0xb2000000000000000000001347ccd9e83d5bf3e0", feed: null, decimals: 8 },
  { symbol: "MARAc", name: "MARA Holdings", address: "0xb200000000000000000000a310e034e09186fb2d", feed: null, decimals: 8 },
  { symbol: "MCDc", name: "McDonald's", address: "0xb200000000000000000000d2f4cf2f7debb244bb", feed: null, decimals: 8 },
  { symbol: "METAc", name: "Meta Platforms", address: "0xb2000000000000000000008bc8786b856e61707c", feed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D", decimals: 8 },
  { symbol: "MNSTc", name: "Monster Beverage", address: "0xb2000000000000000000005bcde0a6926919fef9", feed: null, decimals: 8 },
  { symbol: "MRNAc", name: "Moderna", address: "0xb200000000000000000000e215e9b76ecba02468", feed: null, decimals: 8 },
  { symbol: "MRVLc", name: "Marvell Technology", address: "0xb200000000000000000000ec3c4c7395cc609813", feed: null, decimals: 8 },
  { symbol: "MSFTc", name: "Microsoft", address: "0xb200000000000000000000ab99cfa739e253872b", feed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c", decimals: 8 },
  { symbol: "MSTRc", name: "Strategy", address: "0xb2000000000000000000004884b426556b92883d", feed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a", decimals: 8 },
  { symbol: "MUc", name: "Micron Technology", address: "0xb200000000000000000000fd2f87532b90095211", feed: null, decimals: 8 },
  { symbol: "NFLXc", name: "Netflix", address: "0xb20000000000000000000058b8c947e44011dfe6", feed: null, decimals: 8 },
  { symbol: "NIOc", name: "NIO", address: "0xb2000000000000000000002d2b5dc53c61f1ba06", feed: null, decimals: 8 },
  { symbol: "NOKc", name: "Nokia", address: "0xb2000000000000000000005ac674f707e357409c", feed: null, decimals: 8 },
  { symbol: "NOWc", name: "ServiceNow", address: "0xb20000000000000000000082cd2c7801305808df", feed: null, decimals: 8 },
  { symbol: "NVAXc", name: "Novavax", address: "0xb200000000000000000000c597c476fcf9aed3a8", feed: null, decimals: 8 },
  { symbol: "NVDAc", name: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fe4908108c", feed: "0x04689a41629776563E6822F76f2e57D148d28513", decimals: 8 },
  { symbol: "NVOc", name: "Novo Nordisk", address: "0xb2000000000000000000008d5328e9208773dc58", feed: null, decimals: 8 },
  { symbol: "OKLOc", name: "Oklo", address: "0xb2000000000000000000009188edfd2fcc8cc81e", feed: null, decimals: 8 },
  { symbol: "ONDSc", name: "Ondas", address: "0xb200000000000000000000e7137ca231c5e35f25", feed: null, decimals: 8 },
  { symbol: "OPENc", name: "Opendoor Technologies", address: "0xb200000000000000000000259694b27bf052e7d7", feed: null, decimals: 8 },
  { symbol: "ORCLc", name: "Oracle", address: "0xb200000000000000000000347afba223d7b6b63c", feed: null, decimals: 8 },
  { symbol: "PDDc", name: "PDD Holdings", address: "0xb200000000000000000000c8a7223510467d8563", feed: null, decimals: 8 },
  { symbol: "PFEc", name: "Pfizer", address: "0xb20000000000000000000018fe7ec7d6dfeeb528", feed: null, decimals: 8 },
  { symbol: "PLc", name: "Planet Labs", address: "0xb200000000000000000000cb6b2f4e33f0471556", feed: null, decimals: 8 },
  { symbol: "PLNTc", name: "Planet Fitness", address: "0xb20000000000000000000011b20aebe0bd567f1c", feed: null, decimals: 8 },
  { symbol: "PLTRc", name: "Palantir Technologies", address: "0xb2000000000000000000007d16372840df4dabbe", feed: null, decimals: 8 },
  { symbol: "PMc", name: "Philip Morris International", address: "0xb2000000000000000000008fc2a8c23cf5937b66", feed: null, decimals: 8 },
  { symbol: "PTONc", name: "Peloton Interactive", address: "0xb2000000000000000000009272a491812842aa84", feed: null, decimals: 8 },
  { symbol: "PURRc", name: "Hyperliquid Strategies", address: "0xb20000000000000000000065ca0f772a5502e976", feed: null, decimals: 8 },
  { symbol: "PYPLc", name: "PayPal Holdings", address: "0xb200000000000000000000450ad3abe5d4846c6e", feed: null, decimals: 8 },
  { symbol: "PZZAc", name: "Papa John's International", address: "0xb20000000000000000000068987dacde1db79cd4", feed: null, decimals: 8 },
  { symbol: "QUBTc", name: "Quantum Computing", address: "0xb200000000000000000000ca425ab42e07c35bc3", feed: null, decimals: 8 },
  { symbol: "RBLXc", name: "Roblox", address: "0xb2000000000000000000005bd7ae89b9e6189bb5", feed: null, decimals: 8 },
  { symbol: "RDDTc", name: "Reddit", address: "0xb20000000000000000000066242d4067724cb7a1", feed: null, decimals: 8 },
  { symbol: "RDWc", name: "Redwire", address: "0xb200000000000000000000cd7dfaef0423f1f103", feed: null, decimals: 8 },
  { symbol: "RGTIc", name: "Rigetti Computing", address: "0xb200000000000000000000c22fff2785bb27b39a", feed: null, decimals: 8 },
  { symbol: "RIOTc", name: "Riot Platforms", address: "0xb200000000000000000000bd0c7627b663c581a6", feed: null, decimals: 8 },
  { symbol: "RIVNc", name: "Rivian Automotive", address: "0xb2000000000000000000003e4249c65bd6c037d9", feed: null, decimals: 8 },
  { symbol: "RKLBc", name: "Rocket Lab", address: "0xb200000000000000000000e8e50cbbb9a3861a3c", feed: null, decimals: 8 },
  { symbol: "RKTc", name: "Rocket Companies", address: "0xb200000000000000000000000d3176ee4af1102d", feed: null, decimals: 8 },
  { symbol: "ROOTc", name: "Root", address: "0xb2000000000000000000004aa2b559ca0a0bbf5d", feed: null, decimals: 8 },
  { symbol: "RUNc", name: "Sunrun", address: "0xb200000000000000000000b1b9200405fb52a8cf", feed: null, decimals: 8 },
  { symbol: "RXRXc", name: "Recursion Pharmaceuticals", address: "0xb200000000000000000000501ef81f911eb57656", feed: null, decimals: 8 },
  { symbol: "SANc", name: "Banco Santander", address: "0xb20000000000000000000017bb66e9301e913a99", feed: null, decimals: 8 },
  { symbol: "SAPc", name: "SAP", address: "0xb200000000000000000000da6f64c306234127e0", feed: null, decimals: 8 },
  { symbol: "SBETc", name: "Sharplink", address: "0xb200000000000000000000559ec0bedaacf436ea", feed: null, decimals: 8 },
  { symbol: "SEc", name: "Sea", address: "0xb2000000000000000000003088798f6d0722aaac", feed: null, decimals: 8 },
  { symbol: "SEZLc", name: "Sezzle", address: "0xb2000000000000000000000c1f8acd3c4496a762", feed: null, decimals: 8 },
  { symbol: "SGc", name: "Sweetgreen", address: "0xb200000000000000000000b57f99acec3a7490d0", feed: null, decimals: 8 },
  { symbol: "SHAZc", name: "SharonAI Holdings", address: "0xb2000000000000000000000d9947c759429e7fe5", feed: null, decimals: 8 },
  { symbol: "SKHYc", name: "SK hynix", address: "0xb200000000000000000000187f7071d6e321a7d2", feed: null, decimals: 8 },
  { symbol: "SMRc", name: "NuScale Power", address: "0xb200000000000000000000978546fe604b8dcbc6", feed: null, decimals: 8 },
  { symbol: "SNDKc", name: "Sandisk", address: "0xb200000000000000000000397293cb8cda9a10c5", feed: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA", decimals: 8 },
  { symbol: "SOFIc", name: "SoFi Technologies", address: "0xb2000000000000000000003ef37a7c863dc1482a", feed: null, decimals: 8 },
  { symbol: "SONYc", name: "Sony Group", address: "0xb200000000000000000000a26326a922ffa87f6c", feed: null, decimals: 8 },
  { symbol: "SOUNc", name: "SoundHound AI", address: "0xb2000000000000000000002137743d4a01fe4e88", feed: null, decimals: 8 },
  { symbol: "SPCXc", name: "SpaceX", address: "0xb2000000000000000000007b9fcbd005511acbd5", feed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68", decimals: 8 },
  { symbol: "STZc", name: "Constellation Brands", address: "0xb2000000000000000000001ac12227a8ae0ef3ac", feed: null, decimals: 8 },
  { symbol: "TKOc", name: "TKO Group Holdings", address: "0xb200000000000000000000b8f841940325db6b2c", feed: null, decimals: 8 },
  { symbol: "TSLAc", name: "Tesla", address: "0xb2000000000000000000001e800a7f5189430cd0", feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4", decimals: 8 },
  { symbol: "TTWOc", name: "Take-Two Interactive Software", address: "0xb200000000000000000000f720c26062bc3067da", feed: null, decimals: 8 },
  { symbol: "Uc", name: "Unity Software", address: "0xb200000000000000000000902f48cba1f39149f7", feed: null, decimals: 8 },
  { symbol: "UBERc", name: "Uber Technologies", address: "0xb200000000000000000000cae20cb1446462e24c", feed: null, decimals: 8 },
  { symbol: "ULc", name: "Unilever", address: "0xb200000000000000000000349ef3aa93a0897476", feed: null, decimals: 8 },
  { symbol: "UNHc", name: "UnitedHealth Group", address: "0xb200000000000000000000c367d37d07150182a2", feed: null, decimals: 8 },
  { symbol: "USDEc", name: "StablecoinX", address: "0xb2000000000000000000009426b660396ebcf343", feed: null, decimals: 8 },
  { symbol: "VALEc", name: "Vale", address: "0xb20000000000000000000063376b142c0764b489", feed: null, decimals: 8 },
  { symbol: "VKTXc", name: "Viking Therapeutics", address: "0xb200000000000000000000979ef4dd6a001b58b1", feed: null, decimals: 8 },
  { symbol: "VVVc", name: "Valvoline", address: "0xb200000000000000000000fec679b39992f67627", feed: null, decimals: 8 },
  { symbol: "Wc", name: "Wayfair", address: "0xb20000000000000000000089bc72c3e637a02adb", feed: null, decimals: 8 },
  { symbol: "WDCc", name: "Western Digital", address: "0xb2000000000000000000008fde21a1f5c69fec0b", feed: null, decimals: 8 },
  { symbol: "WENc", name: "Wendy's", address: "0xb20000000000000000000044e3cd7a0e1028e57a", feed: null, decimals: 8 },
  { symbol: "WINGc", name: "Wingstop", address: "0xb200000000000000000000281c973bf2555dd94b", feed: null, decimals: 8 },
  { symbol: "WMTc", name: "Walmart", address: "0xb2000000000000000000008a7508619c717a7106", feed: null, decimals: 8 },
  { symbol: "WRDc", name: "WeRide", address: "0xb200000000000000000000e88efe88d8ade3f0da", feed: null, decimals: 8 },
  { symbol: "WULFc", name: "TeraWulf", address: "0xb200000000000000000000432a1d2bd864acec82", feed: null, decimals: 8 },
  { symbol: "WWc", name: "WW International", address: "0xb20000000000000000000089221e238277d52515", feed: null, decimals: 8 },
  { symbol: "XXIc", name: "Twenty One Capital", address: "0xb200000000000000000000115bf2283265fb04db", feed: null, decimals: 8 },
  { symbol: "XYZc", name: "Block", address: "0xb20000000000000000000067c8c151f24e1c9924", feed: null, decimals: 8 },
  { symbol: "YUMc", name: "YUM! Brands", address: "0xb2000000000000000000005c8324136de0f4134a", feed: null, decimals: 8 },
];

const BY_ADDRESS = new Map(BASE_STOCKS.map((s) => [s.address, s]));

export function baseStockByAddress(address: string): BaseStock | null {
  return BY_ADDRESS.get(address.toLowerCase()) ?? null;
}

/** Coinbase's public registry of its tokenized stocks (no key; docs.base.org/sdks/tokenized-stocks), first page. A reply with `next_page_token` continues at `page_token`. */
export const BASE_STOCK_REGISTRY_URL = "https://api.coinbase.com/v1/tokenized-stocks?page_size=500";
/** A registry with more rows or pages than this is not the registry. */
const MAX_REGISTRY_ROWS = 1000;
const MAX_REGISTRY_PAGES = 10;

/** The URL of a registry page: the first one, or the one a `next_page_token` points at. */
export function baseRegistryPageUrl(pageToken: string | null): string {
  return pageToken === null ? BASE_STOCK_REGISTRY_URL : `${BASE_STOCK_REGISTRY_URL}&page_token=${encodeURIComponent(pageToken)}`;
}
/** A ticker ("U", "GOOGL", "BRK.B") and the issuer's "c". */
const BASE_STOCK_SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?c$/;
const LEGAL_SUFFIX = /(?:,?\s+(?:Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|plc|S\.A\.?|SA\/NV|N\.V\.?|A\/S|SE|AG|PBC|L\.P\.?|&\s+Co\.?|Co\.?))+$/i;

/** The issuer's name the way this list writes it: no legal suffix ("Tesla Inc." → "Tesla", "Eli Lilly & Co" → "Eli Lilly"), plain apostrophes, at most 40 characters. */
export function cleanStockName(name: string): string {
  let s = name.normalize("NFKC").replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, " ").trim();
  s = s.replace(/,?\s+(?:Inc\.?|Corp\.?|Corporation|Ltd\.?|plc)(?=\s+Class\s)/i, ""); // "Berkshire Hathaway Inc. Class B"
  s = s.replace(LEGAL_SUFFIX, "");
  if (!/^The\s/i.test(s)) s = s.replace(/\s+Company$/i, ""); // "Eastman Kodak Company", but "The Hershey Company" keeps it
  return s.slice(0, 40).trim();
}

/**
 * Coinbase's registry reply → stock rows, defensively. A row is kept only with a B20 address, a "<TICKER>c" symbol and
 * 0-18 decimals; the first row wins a repeated address or symbol; a name that is not plain printable text becomes the ticker.
 * No row gets a price feed: a feed is matched to a stock by hand, in the static list.
 */
export function parseBaseRegistry(json: unknown): BaseStock[] {
  const items = (json as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(items) || items.length > MAX_REGISTRY_ROWS) return [];
  const out: BaseStock[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const address = typeof t.contract_address === "string" ? t.contract_address.toLowerCase() : "";
    const symbol = typeof t.symbol === "string" ? t.symbol.trim() : "";
    if (!isB20Address(address) || !BASE_STOCK_SYMBOL.test(symbol) || seen.has(address) || seen.has(symbol)) continue;
    // a number, or a string of digits: never null, "", true or [8], which Number() would turn into 0, 1 or 8
    const decimals = typeof t.decimals === "number" ? t.decimals : typeof t.decimals === "string" && /^\d{1,2}$/.test(t.decimals) ? Number(t.decimals) : NaN;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
    const name = typeof t.name === "string" ? cleanStockName(t.name) : "";
    seen.add(address).add(symbol);
    out.push({ symbol, name: /^[\p{L}\p{N} .,&'!()-]{2,40}$/u.test(name) ? name : underlyingTicker(symbol), address, feed: null, decimals });
  }
  return out;
}

/**
 * Read the whole registry: every page, following `next_page_token`, parsed as one list (so a stock repeated across pages
 * is kept once). Throws on a page with no token list, a page token seen before, or more than MAX_REGISTRY_PAGES pages or
 * MAX_REGISTRY_ROWS rows, so a partial read never stands in for the registry. `getPage` fetches one page's JSON.
 */
export async function readBaseRegistry(getPage: (pageToken: string | null) => Promise<unknown>): Promise<BaseStock[]> {
  const items: unknown[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 1; ; page++) {
    const json = (await getPage(pageToken)) as { tokens?: unknown; next_page_token?: unknown } | null;
    if (!Array.isArray(json?.tokens)) throw new Error(`registry page ${page} has no token list`);
    items.push(...json.tokens);
    if (items.length > MAX_REGISTRY_ROWS) throw new Error(`registry has more than ${MAX_REGISTRY_ROWS} rows`);
    const next = json.next_page_token;
    if (next === undefined || next === null || next === "") break;
    if (typeof next !== "string" || seen.has(next)) throw new Error(`registry page ${page} has a bad or repeated next_page_token`);
    if (page === MAX_REGISTRY_PAGES) throw new Error(`registry has more than ${MAX_REGISTRY_PAGES} pages`);
    seen.add(next);
    pageToken = next;
  }
  return parseBaseRegistry({ tokens: items });
}

/**
 * The static list plus the registry rows it lacks, sorted by ticker like the static list. The registry can only add: a
 * listed address keeps its static row (name, feed), and a new address under a symbol already listed is dropped, so no
 * reply can relabel, unprice or shadow a stock. Nothing new → the same list object back.
 */
export function mergeBaseStocks(known: readonly BaseStock[], live: readonly BaseStock[]): readonly BaseStock[] {
  const addresses = new Set(known.map((s) => s.address));
  const symbols = new Set(known.map((s) => s.symbol.toUpperCase()));
  const added: BaseStock[] = [];
  for (const s of live) {
    const symbol = s.symbol.toUpperCase();
    if (addresses.has(s.address) || symbols.has(symbol)) continue; // listed, or already added from an earlier row: the first wins
    addresses.add(s.address);
    symbols.add(symbol);
    added.push(s);
  }
  if (added.length === 0) return known;
  const ticker = (s: BaseStock) => underlyingTicker(s.symbol);
  return [...known, ...added].sort((a, b) => (ticker(a) < ticker(b) ? -1 : ticker(a) > ticker(b) ? 1 : 0));
}

/** Address shape of a B20 token (does NOT mean it is a Coinbase stock — only the registry decides that). */
export function isB20Address(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address) && address.toLowerCase().startsWith(B20_PREFIX);
}

/** The registry stocks among `addresses` that have a Chainlink feed: the only ones a price is read for. */
export function pricedBaseStocks(addresses: string[]): PricedBaseStock[] {
  return addresses.map((a) => baseStockByAddress(a)).filter((s): s is PricedBaseStock => s !== null && s.feed !== null);
}

/**
 * Ticker/name search over the registry: symbol prefix first, then substring on ticker/name. Within each, stocks with a
 * price feed lead and the rest keep registry (ticker) order, so "U" finds Uc ahead of UBERc. An empty query is the
 * whole registry in that order: the priced stocks fill the first page.
 */
export function searchBaseStocks(q: string, limit = 12, list: readonly BaseStock[] = BASE_STOCKS): BaseStock[] {
  const n = q.trim().toUpperCase().replace(/^\$/, "");
  const rank = (s: BaseStock): number => {
    if (!n || s.symbol.toUpperCase().startsWith(n)) return 0;
    // the ticker, not the symbol: every symbol ends in "c", so a "C" would otherwise match all of them
    return underlyingTicker(s.symbol).includes(n) || s.name.toUpperCase().includes(n) ? 1 : -1;
  };
  return list.map((s) => ({ s, r: rank(s) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || Number(b.s.feed !== null) - Number(a.s.feed !== null))
    .slice(0, limit)
    .map((x) => x.s);
}

/**
 * Which stocks the issuer has put in circulation, from `totalSupply()` reads over `addresses` (same order): true when
 * there is supply, false when the read found none (nobody holds the stock yet, so nobody can buy with it). A failed
 * read says nothing either way, so its address is left out.
 */
export function issuedFromSupply(addresses: readonly string[], reads: readonly { status: string; result?: unknown }[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  addresses.forEach((a, i) => {
    const r = reads[i];
    if (r?.status === "success" && typeof r.result === "bigint") out.set(a.toLowerCase(), r.result > 0n);
  });
  return out;
}

/** Decode Chainlink `latestRoundData()` return data (5 × 32-byte words). */
export function parseRoundData(hex: string): { answer: bigint; updatedAt: number } | null {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 5 * 64) return null;
  const word = (i: number) => BigInt("0x" + h.slice(i * 64, (i + 1) * 64));
  let answer = word(1);
  if (answer >= 1n << 255n) answer -= 1n << 256n; // int256
  return { answer, updatedAt: Number(word(3)) };
}

/** USD per token from a feed reading; null when non-positive, from the future, or older than the trust window. */
export function feedUsd(r: { answer: bigint; updatedAt: number } | null, nowS: number, feedDecimals = 8, maxAgeS = BASE_STOCK_MAX_FEED_AGE_S): number | null {
  if (!r || r.answer <= 0n) return null;
  if (!(r.updatedAt > 0) || r.updatedAt > nowS || nowS - r.updatedAt > maxAgeS) return null;
  return Number(r.answer) / 10 ** feedDecimals;
}

/** RPC error text meaning "this node cannot execute Base-native (B20) precompiles" → retry elsewhere. */
export function isB20RpcError(message: unknown): boolean {
  return typeof message === "string" && /opcode\s*not\s*found|OpcodeNotFound|unsupported opcode|invalid opcode/i.test(message);
}

/** Does a JSON-RPC response (single or batch) carry a B20 execution error anywhere? */
export function responseHasB20Error(json: unknown): boolean {
  const items = Array.isArray(json) ? json : [json];
  return items.some((x) => {
    const e = (x as { error?: { message?: unknown; data?: unknown } } | null)?.error;
    return Boolean(e && (isB20RpcError(e.message) || isB20RpcError(typeof e.data === "string" ? e.data : "")));
  });
}

export const BASE_BLUE = "#0052FF";

/** Underlying ticker of a Coinbase stock token symbol ("NVDAc" → "NVDA"). */
export function underlyingTicker(symbol: string): string {
  return symbol.replace(/c$/, "").toUpperCase();
}

/**
 * Logo tile for a stock without an issuer-provided image: Base-blue rounded square with the underlying
 * ticker in white, as an inline SVG data URL (nothing to fetch, nothing third-party). Used wherever a
 * stock logo is shown; Robinhood stocks keep the logo URL their registry provides.
 */
export function stockTileSvg(symbol: string, bg = BASE_BLUE): string {
  const t = underlyingTicker(symbol).replace(/[^A-Z0-9.]/g, "").slice(0, 5) || "?";
  const size = t.length <= 2 ? 13 : t.length === 3 ? 11 : t.length === 4 ? 9.2 : 7.6;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><text x="16" y="16" dy="0.36em" text-anchor="middle" font-family="Inter,Helvetica,Arial,sans-serif" font-weight="800" font-size="${size}" letter-spacing="-0.02em" fill="#fff">${t}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg).replace(/%20/g, " ")}`;
}
