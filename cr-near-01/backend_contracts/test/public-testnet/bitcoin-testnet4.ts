import { expect } from "chai";
import type { BaseContract, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { network } from "hardhat";
import fs from "node:fs";
import path from "node:path";

import {
  type BitcoinNetwork,
  BitcoinRpc,
  accountId,
  bip143P2wpkhPreimage,
  decodeP2wpkhAddress,
  dsha,
  encodeBitcoinProof,
  findP2wpkhOutput,
  hash160,
  p2wpkhAddress,
  sendDepositTx,
  unsignedWitnessPolicyTx,
  waitForConfirmations,
  witnessTx,
  withdrawalOutputs,
} from "../../scripts/bitcoin/tx-helpers.js";
import type { PublicTestnetDeployment } from "../../scripts/public-testnet-deploy.js";
import { createSigningCommittee } from "../../scripts/signing-committee.js";

const { ethers } = await network.connect();

const DEFAULT_NETWORK: BitcoinNetwork = "testnet4";
const DEFAULT_DEPOSIT_SATS = 100_000n;
const DEFAULT_WITHDRAW_FEE_SATS = 500n;
// The contract burns INITIAL_DEPOSIT_BURN_SATS from every initial deposit (see
// BitcoinBridgeOracle.verifyDeposit). User cWBTC is `deposit − burn`; the
// withdrawal therefore leaves at least `burn` sats in the encumbered UTXO.
// 546 is the Bitcoin ecosystem's standard "definitely-not-dust" value (matches
// P2PKH dust threshold) — well above the ~294-sat P2WPKH threshold, so a
// max-drain withdrawal always produces a relayable change output.
const DEFAULT_INITIAL_DEPOSIT_BURN_SATS = 546n;
const DEFAULT_WITHDRAW_SATS =
  DEFAULT_DEPOSIT_SATS - DEFAULT_WITHDRAW_FEE_SATS - DEFAULT_INITIAL_DEPOSIT_BURN_SATS;
const DEFAULT_WITHDRAWAL_LOCK_SATS = DEFAULT_DEPOSIT_SATS - DEFAULT_INITIAL_DEPOSIT_BURN_SATS;
const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_WAIT_TIMEOUT_MS = 90 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

const BITCOIN_NETWORKS: BitcoinNetwork[] = [
  "mainnet",
  "testnet",
  "testnet4",
  "signet",
  "regtest",
];

const deploymentArtifactPath = (): string => {
  const fromEnv = process.env.PUBLIC_TESTNET_DEPLOYMENT_PATH;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return path.resolve(process.cwd(), "tmp/public-testnet-deployment.json");
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} must be set for the public-testnet Bitcoin test`);
  }
  return value;
};

const optionalEnv = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

const readBigInt = (name: string, fallback: bigint): bigint => {
  const value = optionalEnv(name);
  return value === undefined ? fallback : BigInt(value);
};

const readNumber = (name: string, fallback: number): number => {
  const value = optionalEnv(name);
  return value === undefined ? fallback : Number(value);
};

const readBitcoinNetwork = (): BitcoinNetwork => {
  const value = optionalEnv("BITCOIN_NETWORK");
  if (value === undefined) {
    return DEFAULT_NETWORK;
  }
  if (!BITCOIN_NETWORKS.includes(value as BitcoinNetwork)) {
    throw new Error(
      `BITCOIN_NETWORK=${value} is not one of ${BITCOIN_NETWORKS.join(", ")}`,
    );
  }
  return value as BitcoinNetwork;
};

const btcFromSats = (sats: bigint): string => {
  const whole = sats / 100_000_000n;
  const fraction = (sats % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${fraction}`;
};

const satsFromBtc = (btc: number): bigint => {
  return BigInt(Math.round(btc * 100_000_000));
};

async function openFundedWallet(
  rpcUrl: string,
  walletName: string | undefined,
  minimumSats: bigint,
): Promise<{ wallet: BitcoinRpc; address: string }> {
  const root = new BitcoinRpc(rpcUrl);
  const wallet = walletName === undefined ? root : root.wallet(walletName);
  let balanceBtc: number;
  try {
    balanceBtc = await wallet.call<number>("getbalance");
  } catch (err) {
    throw new Error(
      `Bitcoin RPC getbalance failed for wallet ${walletName ?? "(default)"}: ${
        (err as Error).message
      }. Ensure BITCOIN_WALLET_NAME points at a loaded, watch-only-free wallet.`,
    );
  }
  const balanceSats = satsFromBtc(balanceBtc);
  if (balanceSats < minimumSats) {
    const fundingAddress = await wallet.call<string>("getnewaddress", ["", "bech32"]);
    throw new Error(
      `Bitcoin wallet balance ${balanceSats} sats is below required ${minimumSats} sats. ` +
        `Fund ${fundingAddress} from a testnet faucet and retry.`,
    );
  }
  const address = await wallet.call<string>("getnewaddress", ["", "bech32"]);
  return { wallet, address };
}

function loadDeployment(): PublicTestnetDeployment {
  const artifactPath = deploymentArtifactPath();
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `public testnet deployment artifact not found at ${artifactPath}; run the deployment test first`,
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")) as PublicTestnetDeployment;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForReceipt(
  tx: ContractTransactionResponse,
  timeoutMs = 600_000,
  pollMs = 5_000,
): Promise<ContractTransactionReceipt> {
  console.log(`  tx ${tx.hash} sent; waiting for receipt (timeout ${timeoutMs}ms)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await tx.wait(1).catch(() => null);
    if (receipt !== null) {
      return receipt;
    }
    await sleep(pollMs);
  }
  throw new Error(`tx ${tx.hash} did not produce a receipt within ${timeoutMs}ms`);
}

function assertEventEmitted(
  receipt: ContractTransactionReceipt,
  contract: BaseContract,
  eventName: string,
): Record<string, unknown> {
  const event = contract.interface.getEvent(eventName);
  if (event === null) {
    throw new Error(`unknown event ${eventName} on contract`);
  }
  const log = receipt.logs.find(
    (l) => l.topics[0] === event.topicHash && l.address.toLowerCase() === (contract as any).target.toLowerCase(),
  );
  expect(log, `${eventName} not emitted in tx ${receipt.hash}`).to.exist;
  const parsed = contract.interface.parseLog({ topics: log!.topics as string[], data: log!.data })!;
  const args: Record<string, unknown> = {};
  event.inputs.forEach((input, i) => {
    args[input.name || `arg${i}`] = parsed.args[i];
  });
  return args;
}

const gateRequirements = () =>
  process.env.BITCOIN_RPC_URL === undefined ||
  process.env.SIGNING_COMMITTEE !== "real" ||
  process.env.SIGNING_COMMITTEE_DEPLOYMENT_PATH === undefined;

const maybeRealCommitteeBitcoin = gateRequirements() ? it.skip : it;

describe("public testnet bitcoin (real committee)", function () {
  maybeRealCommitteeBitcoin(
    "runs a real testnet Bitcoin deposit and withdrawal through the deployed stack",
    async function () {
      const confirmations = readNumber("BITCOIN_CONFIRMATIONS", DEFAULT_CONFIRMATIONS);
      const waitTimeoutMs = readNumber("BITCOIN_WAIT_TIMEOUT_MS", DEFAULT_WAIT_TIMEOUT_MS);
      const pollIntervalMs = readNumber("BITCOIN_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS);
      // Two confirmations (one for the deposit, one for the withdrawal) plus committee setup overhead.
      this.timeout(waitTimeoutMs * 2 + 10 * 60_000);

      const network = readBitcoinNetwork();
      const depositSats = readBigInt("BITCOIN_DEPOSIT_SATS", DEFAULT_DEPOSIT_SATS);
      const withdrawSats = readBigInt("BITCOIN_WITHDRAW_SATS", DEFAULT_WITHDRAW_SATS);
      const withdrawFeeSats = readBigInt(
        "BITCOIN_WITHDRAW_FEE_SATS",
        DEFAULT_WITHDRAW_FEE_SATS,
      );
      const withdrawalLockSats = readBigInt(
        "BITCOIN_WITHDRAWAL_LOCK_SATS",
        DEFAULT_WITHDRAWAL_LOCK_SATS,
      );
      const previousKind = process.env.ECDSA_SIGNATURE_KIND;
      process.env.ECDSA_SIGNATURE_KIND = "btc-sha256";

      const minimumSats = depositSats + 50_000n;
      const { wallet, address: walletAddress } = await openFundedWallet(
        requireEnv("BITCOIN_RPC_URL"),
        optionalEnv("BITCOIN_WALLET_NAME"),
        minimumSats,
      );

      // Withdraw back to the same wallet so the spent sats aren't burned.
      // Operator can override via BITCOIN_RECIPIENT_HASH160 (0x-prefixed hash160).
      const recipientHash = optionalEnv("BITCOIN_RECIPIENT_HASH160") ?? decodeP2wpkhAddress(walletAddress).hash;
      if (recipientHash.length !== 42 || !recipientHash.startsWith("0x")) {
        throw new Error(`BITCOIN_RECIPIENT_HASH160 must be 0x-prefixed 20-byte hex`);
      }
      console.log(`withdrawal recipient: ${p2wpkhAddress(recipientHash, network)} (hash160 ${recipientHash})`);

      const deployment = loadDeployment();
      const bitcoin = deployment.sourceChains.bitcoinTestnet;
      // On public networks (Hoodi/Sepolia) hardhat is typically configured with
      // only the deployer signer; fall back to owner so finalizeWithdrawal still
      // executes. The subsidy then flows back to the deployer, which is fine for
      // a test driven by a single operator.
      const signers = await ethers.getSigners();
      const owner = signers[0];
      const prover = signers[1] ?? signers[0];
      const asset = await ethers.getContractAt("CrossroadsAssetContract", bitcoin.asset);
      const blockHashOracle = await ethers.getContractAt(
        "CentralizedBitcoinBlockHashOracle",
        bitcoin.blockHashOracle!,
      );

      const committee = createSigningCommittee(asset as any, owner);
      try {
        await committee.setup();
        const encPubkey = committee.getPublicKey()!;
        const encHash = hash160(encPubkey);
        const encAccount = accountId(encHash);
        expect(committee.getEncAddressId()).to.equal(encAccount);
        await (await committee.registerEncumberedAccount()).wait();

        console.log(
          `depositing ${depositSats} sats to ${p2wpkhAddress(encHash, network)} on ${network}`,
        );
        const deposit = await sendDepositTx(
          wallet,
          owner.address,
          encHash,
          btcFromSats(depositSats),
          network,
        );
        console.log(
          `waiting for ${confirmations} confirmation(s) of deposit ${deposit.txid} (timeout ${waitTimeoutMs}ms)`,
        );
        const depositProof = await waitForConfirmations(
          wallet,
          deposit.txid,
          confirmations,
          waitTimeoutMs,
          pollIntervalMs,
        );
        await (
          await blockHashOracle.setBlockHash(depositProof.height, dsha(depositProof.header))
        ).wait();

        const depositTx = await asset.deposit(
          deposit.rawTx,
          encodeBitcoinProof(
            depositProof.height,
            depositProof.header,
            depositProof.proof,
            depositProof.txIndex,
          ),
        );
        const depositReceipt = await waitForReceipt(depositTx);
        expect(depositReceipt.status).to.equal(1, "deposit tx reverted");
        const depositArgs = assertEventEmitted(depositReceipt, asset, "DepositProcessed");
        expect((depositArgs.sender as string).toLowerCase()).to.equal(owner.address.toLowerCase());
        expect(depositArgs.destination).to.equal(encAccount);
        // Initial deposit burns INITIAL_DEPOSIT_BURN_SATS (Crossroads UTXO dust-safety
        // marker); user is minted (depositSats − burn). Burn is read from the bridge
        // oracle so this stays in sync if the constant ever moves.
        const burnSats = await (await ethers.getContractAt(
          "BitcoinBridgeOracle",
          bitcoin.bridgeOracle,
        )).INITIAL_DEPOSIT_BURN_SATS();
        expect(depositArgs.amount).to.equal(depositSats - burnSats);

        const subsidy = await asset.withdrawalProofReward();
        await (
          await asset.lockWithdrawal(withdrawalLockSats, encAccount, { value: subsidy })
        ).wait();

        const utxo = await findP2wpkhOutput(wallet, deposit.rawTx, encHash);
        const change = utxo.value - withdrawSats - withdrawFeeSats;
        if (change < 0n) {
          throw new Error(
            `withdrawal amount + fee exceeds deposited UTXO value (${utxo.value} sats)`,
          );
        }
        const epoch = Number(await asset.accountEpoch(encAccount));
        const outputs = withdrawalOutputs(
          owner.address,
          encHash,
          recipientHash,
          withdrawSats,
          change,
        );
        const preimage = bip143P2wpkhPreimage(
          deposit.txid,
          utxo.vout,
          utxo.value,
          encHash,
          outputs,
        );
        const policyTx = unsignedWitnessPolicyTx(
          deposit.txid,
          utxo.vout,
          owner.address,
          encPubkey,
          recipientHash,
          withdrawSats,
          change,
        );
        expect(await (asset as any).canSign(owner.address, encAccount, policyTx)).to.equal(true);

        const sighashMidstate = ethers.sha256(preimage);
        const signed = await committee.signRawMessage(sighashMidstate, owner, policyTx);
        expect(signed.signatureKind).to.equal("btc-sha256");

        const signedTx = witnessTx(
          deposit.txid,
          utxo.vout,
          owner.address,
          encPubkey,
          recipientHash,
          withdrawSats,
          change,
          ethers.concat([signed.signature, "0x01"]),
        );
        const withdrawTxid = await wallet.call<string>("sendrawtransaction", [signedTx.slice(2)]);
        console.log(
          `waiting for ${confirmations} confirmation(s) of withdrawal ${withdrawTxid} (timeout ${waitTimeoutMs}ms)`,
        );
        const withdrawProof = await waitForConfirmations(
          wallet,
          withdrawTxid,
          confirmations,
          waitTimeoutMs,
          pollIntervalMs,
        );
        await (
          await blockHashOracle.setBlockHash(withdrawProof.height, dsha(withdrawProof.header))
        ).wait();

        const finalizeTx = await (asset.connect(prover) as typeof asset).finalizeWithdrawal(
          signedTx,
          encodeBitcoinProof(
            withdrawProof.height,
            withdrawProof.header,
            withdrawProof.proof,
            withdrawProof.txIndex,
          ),
          encAccount,
        );
        const finalizeReceipt = await waitForReceipt(finalizeTx);
        expect(finalizeReceipt.status).to.equal(1, "finalizeWithdrawal reverted");
        const finalizeArgs = assertEventEmitted(finalizeReceipt, asset, "WithdrawalFinalized");
        expect((finalizeArgs.spender as string).toLowerCase()).to.equal(owner.address.toLowerCase());
        expect(finalizeArgs.encAccount).to.equal(encAccount);
        expect(finalizeArgs.amountSpent).to.equal(withdrawSats + withdrawFeeSats);
        expect(finalizeArgs.withdrawalProofRewardPaid).to.equal(subsidy);
        expect(await asset.accountEpoch(encAccount)).to.equal(BigInt(epoch + 1));
      } finally {
        await committee.shutdown();
        if (previousKind === undefined) {
          delete process.env.ECDSA_SIGNATURE_KIND;
        } else {
          process.env.ECDSA_SIGNATURE_KIND = previousKind;
        }
      }
    },
  );
});
