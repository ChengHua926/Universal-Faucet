import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { network } from "hardhat";

import { publicTestnetDeploymentConfigFromEnv } from "./public-testnet-config.js";
import { deployPublicTestnetContracts } from "./public-testnet-deploy.js";

const { ethers } = await network.connect();

const deployment = await deployPublicTestnetContracts(
  ethers,
  publicTestnetDeploymentConfigFromEnv(process.env),
);

const outputPath =
  process.env.PUBLIC_TESTNET_DEPLOYMENT_PATH ??
  `deployments/public-testnets-${deployment.target.chainId}.json`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(deployment, null, 2)}\n`);

console.log(`Wrote deployment to ${outputPath}`);
console.log(JSON.stringify(deployment, null, 2));
