import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ethers } from "ethers";

import type { CrossroadsAssetContract } from "../types/ethers-contracts/AssetContract.sol/CrossroadsAssetContract.js";
import type {
  Type2TxMessageSignedStruct,
  Type2TxMessageStruct,
} from "../types/ethers-contracts/EVM/TransactionSerializer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SIGNING_COMMITTEE_ROOT = path.join(REPO_ROOT, "signing_committee");
const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";
const DEFAULT_MEMBER_COUNT = 3;
const DEFAULT_BASE_PORT = 19080;
const COMMITTEE_BOOTSTRAP_ABI = [
  "function registerMember(bytes32 memberId,string publicEndpoint,bytes32 bootstrapPubKey,bytes32 clientAuthPubKey,bytes attestation)",
  "function closeRegistration()",
  "function completeBootstrap()",
] as const;

type SignerWithAddress = ethers.Signer & { address: string };

interface CommitteeDeployment {
  bootstrap: string;
  verifier?: string;
  ecdsaRecoveryHelper?: string;
  ecdsaAsset?: string;
  ed25519Asset?: string;
}

export interface SigningCommittee {
  setup(): Promise<void>;
  shutdown(): Promise<void>;
  getEncAddressId(): string;
  getEncAddress(): string;
  getPublicKey(): string | undefined;
  nativeAddressToAccountId(address: string): string;
  encodeUnsignedTx(unsignedTx: Type2TxMessageStruct): string;
  registerEncumberedAccount(): Promise<any>;
  signTx(
    unsignedTx: Type2TxMessageStruct,
    spender: SignerWithAddress,
  ): Promise<{ signedTx: ethers.Transaction; signedStruct: Type2TxMessageSignedStruct }>;
  signRawMessage(
    message: string,
    spender: SignerWithAddress,
    policyMessage?: string,
  ): Promise<{ signatureKind: string; signature: string; publicKey?: string }>;
}

export function createSigningCommittee(
  asset: CrossroadsAssetContract,
  owner: SignerWithAddress,
): SigningCommittee {
  if (process.env.SIGNING_COMMITTEE === "real") {
    return new RealSigningCommittee(asset, owner);
  }
  return new MockSigningCommittee(asset);
}

abstract class BaseSigningCommittee implements SigningCommittee {
  protected encAccountId: string;
  protected encAddress: string;
  protected publicKey?: string;

  protected constructor(encAccountId: string, encAddress: string, publicKey?: string) {
    this.encAccountId = encAccountId;
    this.encAddress = encAddress;
    this.publicKey = publicKey;
  }

  async setup(): Promise<void> {}

  async shutdown(): Promise<void> {}

  getEncAddressId(): string {
    return this.encAccountId;
  }

  getEncAddress(): string {
    return this.encAddress;
  }

  getPublicKey(): string | undefined {
    return this.publicKey;
  }

  nativeAddressToAccountId(address: string): string {
    return ethers.zeroPadValue(address, 32);
  }

  encodeUnsignedTx(unsignedTx: Type2TxMessageStruct): string {
    const tx = this.toEthersTransaction(unsignedTx);
    return tx.unsignedSerialized;
  }

  async registerEncumberedAccount(): Promise<any> {
    throw new Error("registerEncumberedAccount is not implemented");
  }

  abstract signTx(
    unsignedTx: Type2TxMessageStruct,
    spender: SignerWithAddress,
  ): Promise<{ signedTx: ethers.Transaction; signedStruct: Type2TxMessageSignedStruct }>;

  abstract signRawMessage(
    message: string,
    spender: SignerWithAddress,
    policyMessage?: string,
  ): Promise<{ signatureKind: string; signature: string; publicKey?: string }>;

  protected toEthersTransaction(unsignedTx: Type2TxMessageStruct): ethers.Transaction {
    return ethers.Transaction.from({
      type: 2,
      chainId: unsignedTx.chainId,
      nonce: Number(unsignedTx.nonce),
      maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
      maxFeePerGas: unsignedTx.maxFeePerGas,
      gasLimit: unsignedTx.gasLimit,
      to: unsignedTx.destination.length > 0 ? ethers.hexlify(unsignedTx.destination) : null,
      value: unsignedTx.amount,
      data: ethers.hexlify(unsignedTx.payload),
    });
  }

  protected signedStruct(tx: ethers.Transaction): Type2TxMessageSignedStruct {
    return {
      transaction: {
        chainId: tx.chainId,
        nonce: tx.nonce,
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? 0n,
        maxFeePerGas: tx.maxFeePerGas ?? 0n,
        gasLimit: tx.gasLimit,
        destination: tx.to ?? "0x",
        amount: tx.value,
        payload: tx.data,
      },
      r: tx.signature!.r,
      s: tx.signature!.s,
      v: tx.signature!.v,
    };
  }
}

export class MockSigningCommittee extends BaseSigningCommittee {
  private readonly encumberedWallet: ethers.HDNodeWallet | ethers.Wallet;
  private readonly asset: CrossroadsAssetContract;

  constructor(asset: CrossroadsAssetContract, privateKey?: string) {
    const wallet =
      privateKey !== undefined ? new ethers.Wallet(privateKey) : ethers.Wallet.createRandom();
    const publicKey = ethers.SigningKey.computePublicKey(wallet.privateKey, true);
    const encAccountId =
      ecdsaSignatureKind() === "btc-sha256"
        ? bitcoinAccountId(publicKey)
        : ethers.zeroPadValue(wallet.address, 32);
    super(encAccountId, wallet.address, publicKey);
    this.encumberedWallet = wallet;
    this.asset = asset;
  }

  async registerEncumberedAccount(): Promise<any> {
    return this.asset.registerEncumberedAccount(this.encAccountId);
  }

  async signTx(
    unsignedTx: Type2TxMessageStruct,
    spender: SignerWithAddress,
  ): Promise<{ signedTx: ethers.Transaction; signedStruct: Type2TxMessageSignedStruct }> {
    const unsignedTxHex = this.encodeUnsignedTx(unsignedTx);
    const spenderSig = await spender.signMessage(ethers.getBytes(unsignedTxHex));
    const recovered = ethers.verifyMessage(ethers.getBytes(unsignedTxHex), spenderSig);
    if (recovered.toLowerCase() !== spender.address.toLowerCase()) {
      throw new Error("Spender signature does not match the supplied address");
    }

    const can = await (this.asset as any).canSign(
      spender.address,
      this.encAccountId,
      unsignedTxHex,
    );
    if (!can) {
      throw new Error("Spender is not eligible to sign for the current epoch");
    }

    const signed = await this.encumberedWallet.signTransaction({
      type: 2,
      chainId: unsignedTx.chainId,
      nonce: Number(unsignedTx.nonce),
      maxPriorityFeePerGas: unsignedTx.maxPriorityFeePerGas,
      maxFeePerGas: unsignedTx.maxFeePerGas,
      gasLimit: unsignedTx.gasLimit,
      to: unsignedTx.destination.length > 0 ? ethers.hexlify(unsignedTx.destination) : null,
      value: unsignedTx.amount,
      data: ethers.hexlify(unsignedTx.payload),
    });
    const tx = ethers.Transaction.from(signed);
    return { signedStruct: this.signedStruct(tx), signedTx: tx };
  }

  async signRawMessage(
    message: string,
    spender: SignerWithAddress,
    policyMessage = message,
  ): Promise<{ signatureKind: string; signature: string; publicKey?: string }> {
    const payload = signingPayload("", this.encAccountId, message, policyMessage);
    const spenderSig = await spender.signMessage(JSON.stringify(payload));
    const recovered = ethers.verifyMessage(JSON.stringify(payload), spenderSig);
    if (recovered.toLowerCase() !== spender.address.toLowerCase()) {
      throw new Error("Spender signature does not match the supplied address");
    }

    const can = await (this.asset as any).canSign(
      spender.address,
      this.encAccountId,
      policyMessage,
    );
    if (!can) {
      throw new Error("Spender is not eligible to sign for the current epoch");
    }

    const signatureKind = ecdsaSignatureKind();
    const signingKey = new ethers.SigningKey(this.encumberedWallet.privateKey);
    if (signatureKind === "btc-sha256") {
      const signature = signingKey.sign(ethers.sha256(message));
      return { signatureKind, signature: derEncodeSignature(signature), publicKey: this.publicKey };
    }
    if (signatureKind === "eth-keccak") {
      return {
        signatureKind,
        signature: signingKey.sign(ethers.keccak256(message)).serialized,
        publicKey: this.publicKey,
      };
    }
    if (signatureKind === "raw32") {
      const bytes = ethers.getBytes(message);
      if (bytes.length !== 32) {
        throw new Error(
          `signature-kind raw32 requires a 32-byte message, got ${bytes.length} bytes`,
        );
      }
      const signature = signingKey.sign(message);
      return {
        signatureKind,
        signature: ethers.concat([signature.r, signature.s]),
        publicKey: this.publicKey,
      };
    }
    throw new Error(`unsupported ECDSA signature kind ${signatureKind}`);
  }
}

export class RealSigningCommittee extends BaseSigningCommittee {
  private readonly asset: CrossroadsAssetContract;
  private readonly owner: SignerWithAddress;
  private readonly assetRpcUrl: string;
  private readonly deploymentPath: string;
  private readonly basePort: number;
  private readonly memberCount: number;
  private readonly threshold: number;
  private readonly workDir: string;
  private signatureKind: string;
  private readonly memberWallets: ethers.HDNodeWallet[];
  private readonly processes: ChildProcess[] = [];
  private assetEncAccountId = "";
  private bootstrapAddress = "";

  constructor(asset: CrossroadsAssetContract, owner: SignerWithAddress) {
    const requestEncAccountId = process.env.REAL_COMMITTEE_ENC_ACCOUNT ?? hex32(0xa11ce);
    super(requestEncAccountId, ethers.ZeroAddress);
    this.asset = asset;
    this.owner = owner;
    this.assetRpcUrl = process.env.ASSET_RPC_URL ?? "http://127.0.0.1:8545";
    this.deploymentPath = process.env.SIGNING_COMMITTEE_DEPLOYMENT_PATH ?? "";
    if (!this.deploymentPath) {
      throw new Error("SIGNING_COMMITTEE_DEPLOYMENT_PATH must be set for the real committee path");
    }
    this.basePort = Number(process.env.SIGNING_COMMITTEE_BASE_PORT ?? DEFAULT_BASE_PORT);
    this.memberCount = Number(process.env.SIGNING_COMMITTEE_SIZE ?? DEFAULT_MEMBER_COUNT);
    if (this.memberCount < 3 || this.memberCount % 2 === 0) {
      throw new Error("SIGNING_COMMITTEE_SIZE must be an odd number >= 3");
    }
    this.threshold = Math.floor((this.memberCount + 1) / 2);
    this.workDir =
      process.env.SIGNING_COMMITTEE_WORKDIR ??
      path.join(SIGNING_COMMITTEE_ROOT, "tmp", `backend-contracts-real-committee-${process.pid}`);
    this.signatureKind = ecdsaSignatureKind();
    this.memberWallets = resolveMemberWallets(this.memberCount, this.assetRpcUrl);
  }

  async setup(): Promise<void> {
    fs.rmSync(this.workDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.workDir, "nodes"), { recursive: true });
    const deployment = this.loadDeployment();
    this.bootstrapAddress = ethers.getAddress(deployment.bootstrap);
    const bootstrap = new ethers.Contract(
      this.bootstrapAddress,
      COMMITTEE_BOOTSTRAP_ABI,
      this.owner,
    ) as any;

    for (let i = 0; i < this.memberCount; i++) {
      const member = this.memberWallets[i];
      const memberId = hex32(i + 1);
      const endpoint = `http://127.0.0.1:${this.basePort + i}`;
      const bootstrapPub = hex32(0xb000 + i + 1);
      const clientPub = hex32(0xc000 + i + 1);
      const digest = ethers.solidityPackedKeccak256(
        ["string", "address", "bytes32", "address", "string", "bytes32", "bytes32"],
        [
          "HD_MPC_COMMITTEE_ATTEST_V1",
          this.bootstrapAddress,
          memberId,
          member.address,
          endpoint,
          bootstrapPub,
          clientPub,
        ],
      );
      const attestation = member.signingKey.sign(digest).serialized;
      await bootstrap
        .connect(member)
        .registerMember(memberId, endpoint, bootstrapPub, clientPub, attestation)
        .then((r: any) => r.wait());
    }

    await bootstrap.closeRegistration().then((r: any) => r.wait());
    await bootstrap.completeBootstrap().then((r: any) => r.wait());

    this.startNodes();
    await Promise.all(
      Array.from({ length: this.memberCount }, (_, i) =>
        waitForHttp(`http://127.0.0.1:${this.basePort + i}/healthz`),
      ),
    );

    for (let i = 0; i < this.threshold; i++) {
      await httpJson(`http://127.0.0.1:${this.basePort + i}/v1/bootstrap/init`, {});
    }
    const status = await httpJson(`http://127.0.0.1:${this.basePort}/v1/bootstrap/status`);
    if (
      !status.schemes.every((s: any) => s.initialized === true && s.root_record_active === true)
    ) {
      throw new Error(`committee roots were not activated: ${JSON.stringify(status)}`);
    }

    const assetSchemeId = Number(await this.asset.signatureScheme());
    const expectedScheme = assetSchemeId === 2 ? "ed25519" : "ecdsa-secp256k1";
    if (assetSchemeId === 2) {
      this.signatureKind = "ed25519-rfc8032-raw";
    }

    const derived = await httpJson(`http://127.0.0.1:${this.basePort}/v1/derived-key`, {
      asset_contract: (await this.asset.getAddress()).toLowerCase(),
      encumbered_account: this.encAccountId,
    });
    if (derived.scheme !== expectedScheme) {
      throw new Error(`unexpected derived key response: ${JSON.stringify(derived)}`);
    }
    if (typeof derived.public_key !== "string") {
      throw new Error(`derived key response is missing a public key: ${JSON.stringify(derived)}`);
    }
    const publicKey = derived.public_key as string;
    this.publicKey = publicKey;
    if (assetSchemeId === 2) {
      const publicKeyBytes = ethers.getBytes(publicKey);
      if (publicKeyBytes.length !== 32) {
        throw new Error(`ed25519 public key must be 32 bytes, got ${publicKeyBytes.length}`);
      }
      this.encAddress = publicKey;
      this.assetEncAccountId = ethers.hexlify(publicKeyBytes);
    } else {
      this.encAddress = ecdsaPublicKeyToEvmAddress(publicKey);
      this.assetEncAccountId =
        this.signatureKind === "btc-sha256"
          ? bitcoinAccountId(publicKey)
          : this.nativeAddressToAccountId(this.encAddress);
    }
  }

  async shutdown(): Promise<void> {
    for (const child of this.processes) {
      if (!child.killed) {
        child.kill();
      }
    }
    await Promise.all(this.processes.map((child) => waitForExit(child)));
  }

  getEncAddressId(): string {
    return this.assetEncAccountId;
  }

  async registerEncumberedAccount(): Promise<any> {
    return this.asset.registerEncumberedAccount(this.assetEncAccountId);
  }

  async signTx(
    unsignedTx: Type2TxMessageStruct,
    spender: SignerWithAddress,
  ): Promise<{ signedTx: ethers.Transaction; signedStruct: Type2TxMessageSignedStruct }> {
    const unsignedTxHex = this.encodeUnsignedTx(unsignedTx);
    const payload = signingPayload(
      await this.asset.getAddress(),
      this.encAccountId,
      unsignedTxHex,
      unsignedTxHex,
      this.assetEncAccountId,
    );
    const userSignature = await spender.signMessage(JSON.stringify(payload));
    const response = await httpJson(`http://127.0.0.1:${this.basePort}/v1/sign`, {
      ...payload,
      user_signature: userSignature,
    });
    if (response.signature_kind !== "eth-keccak") {
      throw new Error(`expected eth-keccak ECDSA signature, got ${response.signature_kind}`);
    }
    if (
      typeof response.public_key !== "string" ||
      ecdsaPublicKeyToEvmAddress(response.public_key).toLowerCase() !==
        this.encAddress.toLowerCase()
    ) {
      throw new Error(`signature came from unexpected public key: ${response.public_key}`);
    }

    const signature = ethers.Signature.from(response.signature);
    const recovered = ethers.recoverAddress(ethers.keccak256(unsignedTxHex), signature);
    if (recovered.toLowerCase() !== this.encAddress.toLowerCase()) {
      throw new Error("committee returned a signature for the wrong EVM address");
    }
    const tx = this.toEthersTransaction(unsignedTx);
    tx.signature = signature;
    return { signedStruct: this.signedStruct(tx), signedTx: tx };
  }

  async signRawMessage(
    message: string,
    spender: SignerWithAddress,
    policyMessage = message,
  ): Promise<{ signatureKind: string; signature: string; publicKey?: string }> {
    const payload = signingPayload(
      await this.asset.getAddress(),
      this.encAccountId,
      message,
      policyMessage,
      this.assetEncAccountId,
    );
    const userSignature = await spender.signMessage(JSON.stringify(payload));
    const response = await httpJson(`http://127.0.0.1:${this.basePort}/v1/sign`, {
      ...payload,
      user_signature: userSignature,
    });
    if (response.signature_kind !== this.signatureKind) {
      throw new Error(
        `expected ${this.signatureKind} signature, got ${response.signature_kind}`,
      );
    }
    if (
      typeof response.public_key !== "string" ||
      response.public_key.toLowerCase() !== this.publicKey?.toLowerCase()
    ) {
      throw new Error(`signature came from unexpected public key: ${response.public_key}`);
    }
    return {
      signatureKind: response.signature_kind,
      signature: response.signature,
      publicKey: response.public_key,
    };
  }

  private startNodes(): void {
    const bin =
      process.env.SIGNING_COMMITTEE_BIN ??
      path.join(SIGNING_COMMITTEE_ROOT, "target", "debug", "crossroads-near-mpc-committee");
    if (!fs.existsSync(bin)) {
      throw new Error(
        `signing committee binary not found at ${bin}; run cargo build in signing_committee`,
      );
    }

    for (let i = 0; i < this.memberCount; i++) {
      const nodeDir = path.join(this.workDir, "nodes", `node-${i + 1}`);
      fs.mkdirSync(nodeDir, { recursive: true });
      const child = spawn(bin, {
        cwd: SIGNING_COMMITTEE_ROOT,
        env: {
          ...process.env,
          COMMITTEE_LISTEN: `127.0.0.1:${this.basePort + i}`,
          COMMITTEE_SELF_MEMBER_ID: hex32(i + 1),
          EVM_RPC_URL: this.assetRpcUrl,
          BOOTSTRAP_CONTRACT: this.bootstrapAddress,
          ECDSA_ROOT_SHARE_FILE: path.join(nodeDir, "root-ecdsa.json"),
          ED25519_ROOT_SHARE_FILE: path.join(nodeDir, "root-ed25519.json"),
          ADMIN_PRIVATE_KEY: this.memberWallets[i].privateKey,
          ECDSA_SIGNATURE_KIND: this.signatureKind,
          RUST_LOG: process.env.RUST_LOG ?? "info",
        },
        stdio: [
          "ignore",
          fs.openSync(path.join(nodeDir, "service.log"), "a"),
          fs.openSync(path.join(nodeDir, "service.log"), "a"),
        ],
      });
      this.processes.push(child);
    }
  }

  private async sendRpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.assetRpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body: any = await response.json();
    if (body.error) {
      throw new Error(`${method} failed: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }

  private loadDeployment(): CommitteeDeployment {
    const raw = fs.readFileSync(this.deploymentPath, "utf8");
    const deployment = JSON.parse(raw) as Partial<CommitteeDeployment>;
    if (typeof deployment.bootstrap !== "string" || deployment.bootstrap.length === 0) {
      throw new Error(`invalid committee deployment file at ${this.deploymentPath}`);
    }
    return deployment as CommitteeDeployment;
  }
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function resolveMemberWallets(
  memberCount: number,
  rpcUrl: string,
): ethers.HDNodeWallet[] {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const explicitKeys = (process.env.COMMITTEE_MEMBER_PRIVATE_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (explicitKeys.length > 0) {
    if (explicitKeys.length !== memberCount) {
      throw new Error(
        `COMMITTEE_MEMBER_PRIVATE_KEYS has ${explicitKeys.length} keys but SIGNING_COMMITTEE_SIZE is ${memberCount}. ` +
          `In production each committee member generates their own key independently; supply one comma-separated key per member.`,
      );
    }
    return explicitKeys.map(
      (key) => new ethers.Wallet(key, provider) as unknown as ethers.HDNodeWallet,
    );
  }
  const mnemonic = process.env.COMMITTEE_MNEMONIC ?? DEFAULT_MNEMONIC;
  return Array.from({ length: memberCount }, (_, i) =>
    ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i + 2}`).connect(provider),
  );
}

function ecdsaSignatureKind(): string {
  return process.env.ECDSA_SIGNATURE_KIND ?? "eth-keccak";
}

function bitcoinAccountId(publicKey: string): string {
  // Bitcoin's encAccount is the 20-byte witness hash160 left-aligned in a
  // 32-byte slot (`hash160 ++ 12 zero bytes`). See
  // BitcoinBridgeOracle._hash160FromAccount, which recovers the hash via
  // `bytes20(encAccount)`.
  const hash160 = ethers.ripemd160(ethers.getBytes(ethers.sha256(publicKey)));
  return ethers.concat([hash160, "0x" + "00".repeat(12)]);
}

function ecdsaPublicKeyToEvmAddress(publicKey: string): string {
  return ethers.computeAddress(publicKey);
}

function signingPayload(
  assetContract: string,
  encAccount: string,
  message: string,
  policyMessage: string,
  policyEncAccount = encAccount,
): Record<string, string> {
  const payload: Record<string, string> = {
    asset_contract: assetContract.toLowerCase(),
    encumbered_account: encAccount.toLowerCase(),
    message: message.toLowerCase(),
  };
  if (policyEncAccount.toLowerCase() !== encAccount.toLowerCase()) {
    payload.policy_encumbered_account = policyEncAccount.toLowerCase();
  }
  if (policyMessage.toLowerCase() !== message.toLowerCase()) {
    payload.policy_message = policyMessage.toLowerCase();
  }
  return payload;
}

function derEncodeSignature(signature: ethers.Signature): string {
  const r = derInteger(signature.r);
  const s = derInteger(signature.s);
  const sequenceLength = r.length + s.length + 4;
  return ethers.hexlify(
    Uint8Array.from([0x30, sequenceLength, 0x02, r.length, ...r, 0x02, s.length, ...s]),
  );
}

function derInteger(value: string): number[] {
  const bytes = Array.from(ethers.getBytes(value));
  while (bytes.length > 1 && bytes[0] === 0) {
    bytes.shift();
  }
  if ((bytes[0] & 0x80) !== 0) {
    bytes.unshift(0);
  }
  return bytes;
}

async function waitForHttp(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 204) {
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`service did not become ready at ${url}`);
}

async function httpJson(url: string, body?: unknown): Promise<any> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}: ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) : {};
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000);
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
