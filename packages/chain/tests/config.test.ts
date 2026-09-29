import { describe, expect, it } from "vitest";

import { ChainConfigError, loadChainConfigFromEnv } from "../src/index.js";

const BASE_ENV = {
  ROBINHOOD_CHAIN_ID: "4663",
  ROBINHOOD_CHAIN_RPC_URL: "https://rpc.mainnet.chain.robinhood.com"
};

describe("loadChainConfigFromEnv", () => {
  it("parses a full configuration and checksums addresses", () => {
    const config = loadChainConfigFromEnv({
      ...BASE_ENV,
      UNISWAP_V2_FACTORY_ADDRESS: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
      UNISWAP_V2_FACTORY_START_BLOCK: "9486",
      UNISWAP_V3_FACTORY_ADDRESS: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
      UNISWAP_V3_FACTORY_START_BLOCK: "8930",
      QUOTE_ASSET_WETH_ADDRESS: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      QUOTE_ASSET_USDG_ADDRESS: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      QUOTE_ASSET_VIRTUAL_ADDRESS: "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31"
    });

    expect(config.chainId).toBe(4663);
    expect(config.rpcUrls).toEqual(["https://rpc.mainnet.chain.robinhood.com"]);
    expect(config.factories).toHaveLength(2);
    expect(config.factories[0]).toMatchObject({
      dex: "uniswap",
      kind: "uniswap-v2",
      // EIP-55 checksummed, not the lowercase input.
      address: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
      deploymentBlock: 9486n
    });
    expect(config.factories[1]).toMatchObject({
      kind: "uniswap-v3",
      deploymentBlock: 8930n
    });
    // Preference order: WETH before stablecoins, VIRTUAL always last so a
    // VIRTUAL/WETH pool keeps WETH as its quote side.
    expect(config.quoteAssets.map((asset) => asset.symbol)).toEqual([
      "WETH",
      "USDG",
      "VIRTUAL"
    ]);
    expect(config.quoteAssets[0]?.decimals).toBe(18);
    expect(config.quoteAssets[1]?.decimals).toBe(6);
    expect(config.quoteAssets[2]).toMatchObject({
      decimals: 18,
      // EIP-55 checksummed, not the lowercase input.
      address: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31"
    });
  });

  it("omits factories and quote assets whose addresses are unset", () => {
    const config = loadChainConfigFromEnv(BASE_ENV);
    expect(config.factories).toEqual([]);
    expect(config.quoteAssets).toEqual([]);
  });

  it("rejects a missing chain id", () => {
    expect(() =>
      loadChainConfigFromEnv({
        ROBINHOOD_CHAIN_RPC_URL: BASE_ENV.ROBINHOOD_CHAIN_RPC_URL
      })
    ).toThrow(ChainConfigError);
  });

  it("rejects a non-numeric chain id", () => {
    expect(() =>
      loadChainConfigFromEnv({ ...BASE_ENV, ROBINHOOD_CHAIN_ID: "mainnet" })
    ).toThrow(ChainConfigError);
  });

  it("rejects a malformed factory address instead of ignoring it", () => {
    expect(() =>
      loadChainConfigFromEnv({
        ...BASE_ENV,
        UNISWAP_V2_FACTORY_ADDRESS: "0x1234"
      })
    ).toThrow(ChainConfigError);
  });

  it("rejects a factory address without a start block", () => {
    expect(() =>
      loadChainConfigFromEnv({
        ...BASE_ENV,
        UNISWAP_V2_FACTORY_ADDRESS:
          "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"
      })
    ).toThrow(ChainConfigError);
  });

  it("rejects a negative start block", () => {
    expect(() =>
      loadChainConfigFromEnv({
        ...BASE_ENV,
        UNISWAP_V2_FACTORY_ADDRESS:
          "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
        UNISWAP_V2_FACTORY_START_BLOCK: "-5"
      })
    ).toThrow(ChainConfigError);
  });
});
