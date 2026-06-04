// Loads the OFFICIAL precompiled Uniswap v2 artifacts. We deploy the canonical
// bytecode (not a recompile) because UniswapV2Router02 hard-codes the pair
// init-code-hash; recompiling would change it and break pairFor/addLiquidity.
// Verified: keccak256(UniswapV2Pair.bytecode) == the router's hard-coded hash.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const factoryArtifact = require("@uniswap/v2-core/build/UniswapV2Factory.json");
export const pairArtifact = require("@uniswap/v2-core/build/UniswapV2Pair.json");
export const routerArtifact = require("@uniswap/v2-periphery/build/UniswapV2Router02.json");

// These artifacts store bytecode without the 0x prefix.
export function bytecodeOf(artifact: { bytecode: string }): string {
  return artifact.bytecode.startsWith("0x") ? artifact.bytecode : `0x${artifact.bytecode}`;
}
