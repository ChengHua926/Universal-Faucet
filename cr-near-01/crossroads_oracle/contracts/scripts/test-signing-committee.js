// Deploy the SigningCommittee (James's EIP-712 design) + a MockCanSign on
// Sapphire testnet and verify the confidential signer end-to-end:
//   1. derivation is deterministic; assetAccount == bytes32(uint160(signer))
//   2. the on-chain EIP-712 requestDigest matches the client's typed-data hash,
//      and recoverRequester returns the requester
//   3. sign() returns a DER signature whose (r,s)+recovered v verify against the
//      derived signer over keccak256(txData)  ← proves the Sapphire.sign fix
//   4. canSign gating works (sign reverts when the policy says no)
//   5. a foreign requester is rejected when the policy pins an allowed spender
//
//   PRIVATE_KEY=0x...(funded ROSE) \
//     npx hardhat run scripts/test-signing-committee.js --network sapphire-testnet

const hre = require("hardhat");
const { ethers } = hre;

const ALG = 1; // ALG_SECP256K1_KECCAK256

// --- decode Sapphire's ASN.1 DER secp256k1 signature into (r,s,v) ------------
function pad32(bytes) {
  let x = bytes;
  while (x.length > 32 && x[0] === 0x00) x = x.slice(1); // strip DER sign byte
  const out = new Uint8Array(32);
  out.set(x, 32 - x.length);
  return ethers.hexlify(out);
}
function parseDer(derHex) {
  const d = ethers.getBytes(derHex);
  if (d[0] !== 0x30) throw new Error("not a DER sequence");
  let i = 2;
  if (d[i] !== 0x02) throw new Error("DER: expected r");
  const rlen = d[i + 1];
  i += 2;
  const r = d.slice(i, i + rlen);
  i += rlen;
  if (d[i] !== 0x02) throw new Error("DER: expected s");
  const slen = d[i + 1];
  i += 2;
  const s = d.slice(i, i + slen);
  return { r: pad32(r), s: pad32(s) };
}
function toRSV(derHex, digest, signer) {
  const { r, s } = parseDer(derHex);
  for (const v of [27, 28]) {
    if (ethers.recoverAddress(digest, { r, s, v }).toLowerCase() === signer.toLowerCase()) {
      return { r, s, v };
    }
  }
  throw new Error("could not recover v against the derived signer");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  console.log("deployer:", deployer.address, "chainId:", chainId.toString());

  // bytes32(0) seed => the enclave generates the root with secure randomness.
  const committee = await (await ethers.getContractFactory("SigningCommittee")).deploy(
    ethers.ZeroHash,
    { gasLimit: 6_000_000 },
  );
  await committee.waitForDeployment();
  const committeeAddr = await committee.getAddress();
  console.log("SigningCommittee:", committeeAddr);

  const mock = await (await ethers.getContractFactory("MockCanSign")).deploy({ gasLimit: 2_000_000 });
  await mock.waitForDeployment();
  const asset = await mock.getAddress();
  console.log("MockCanSign asset:", asset);

  const encAccount = ethers.keccak256(ethers.toUtf8Bytes("withdraw-account-1")); // derivation label
  const txData = ethers.hexlify(ethers.randomBytes(120)); // pretend unsigned tx (mock ignores it)

  // (1) deterministic derivation
  const signer = await committee.signerAddress(asset, encAccount, ALG);
  const signer2 = await committee.signerAddress(asset, encAccount, ALG);
  const [aSigner, assetEncId] = await committee.assetAccount(asset, encAccount, ALG);
  const detOk =
    signer === signer2 &&
    aSigner === signer &&
    assetEncId.toLowerCase() === ethers.zeroPadValue(signer, 32).toLowerCase();
  console.log(`\nderived signer: ${signer}`);
  console.log(`assetEncId:     ${assetEncId}`);

  // (2) EIP-712 request: on-chain digest == client typed-data hash; recover requester
  const requester = ethers.Wallet.createRandom();
  const domain = { name: "SigningCommittee", version: "1", chainId, verifyingContract: committeeAddr };
  const reqTypes = {
    SignRequest: [
      { name: "asset", type: "address" },
      { name: "encAccount", type: "bytes32" },
      { name: "txData", type: "bytes" },
    ],
  };
  const reqValue = { asset, encAccount, txData };
  const clientDigest = ethers.TypedDataEncoder.hash(domain, reqTypes, reqValue);
  const onChainDigest = await committee.requestDigest(asset, encAccount, txData);
  const reqSig = await requester.signTypedData(domain, reqTypes, reqValue);
  const recoveredRequester = await committee.recoverRequester(asset, encAccount, txData, reqSig);
  const reqOk =
    clientDigest === onChainDigest && recoveredRequester.toLowerCase() === requester.address.toLowerCase();

  // (3) confidential sign (view / eth_call) -> DER -> verify
  const der = await committee.sign(asset, encAccount, ALG, txData, reqSig);
  const digest = ethers.keccak256(txData);
  let sigOk = false;
  let recovered = "n/a";
  try {
    const rsv = toRSV(der, digest, signer);
    recovered = ethers.recoverAddress(digest, rsv);
    sigOk = recovered.toLowerCase() === signer.toLowerCase();
  } catch (e) {
    recovered = `decode failed: ${e.message}`;
  }

  console.log(`\nsign() -> DER ${der.slice(0, 14)}… (${(der.length - 2) / 2} bytes)`);
  console.log(`  1. deterministic derivation + assetEncId == uint160(signer): ${detOk ? "✅" : "❌"}`);
  console.log(`  2. EIP-712 digest matches client + recovers requester:       ${reqOk ? "✅" : "❌"}`);
  console.log(`  3. DER signature recovers to derived signer:                 ${sigOk ? "✅" : "❌"} (${recovered})`);

  // (4) canSign gating
  await (await mock.setAllow(false)).wait();
  let gateOk = false;
  try {
    await committee.sign(asset, encAccount, ALG, txData, reqSig);
  } catch (e) {
    gateOk = /asset rejected/.test(e.shortMessage || e.message || "");
  }
  await (await mock.setAllow(true)).wait();
  console.log(`  4. reverts when canSign=false:                               ${gateOk ? "✅" : "❌"}`);

  // (5) wrong requester rejected when the policy pins an allowed spender
  await (await mock.setAllowedSpender(requester.address)).wait();
  const intruder = ethers.Wallet.createRandom();
  const intruderSig = await intruder.signTypedData(domain, reqTypes, reqValue);
  let pinOk = false;
  try {
    await committee.sign(asset, encAccount, ALG, txData, intruderSig);
  } catch (e) {
    pinOk = /asset rejected/.test(e.shortMessage || e.message || "");
  }
  // the original (correct) requester still works
  const der2 = await committee.sign(asset, encAccount, ALG, txData, reqSig);
  const stillOk = der2 && der2.length > 2;
  console.log(`  5. foreign requester rejected, real requester ok:            ${pinOk && stillOk ? "✅" : "❌"}`);

  const allOk = detOk && reqOk && sigOk && gateOk && pinOk && stillOk;
  console.log(
    `\n${allOk ? "✅ ALL CHECKS PASSED — SigningCommittee (James's EIP-712 design) is a working signing committee" : "❌ some checks failed"}`,
  );
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
