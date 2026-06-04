// Deploy SapphireSigningCommittee + a MockCanSign on Sapphire testnet and verify
// the confidential signer end-to-end:
//   1. derivation is deterministic (encumberedAccount == address returned by sign)
//   2. the returned (r,s,v) recovers to the derived address over keccak256(message)
//   3. canSign gating works (sign reverts when the policy says no)
//   4. a foreign spender signature is rejected by an allowed-spender policy
//
//   PRIVATE_KEY=0x...(funded ROSE) \
//     npx hardhat run scripts/test-sapphire-committee.js --network sapphire-testnet

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  const committee = await (await ethers.getContractFactory("SapphireSigningCommittee")).deploy({
    gasLimit: 6_000_000,
  });
  await committee.waitForDeployment();
  const committeeAddr = await committee.getAddress();
  console.log("SapphireSigningCommittee:", committeeAddr);

  const mock = await (await ethers.getContractFactory("MockCanSign")).deploy({ gasLimit: 2_000_000 });
  await mock.waitForDeployment();
  const asset = await mock.getAddress();
  console.log("MockCanSign asset:", asset);

  const accountId = ethers.keccak256(ethers.toUtf8Bytes("withdraw-account-1"));

  // (1) deterministic derivation
  const [addr, encId] = await committee.encumberedAccount(asset, accountId);
  console.log(`\nderived encumbered: addr=${addr}\n                    encId=${encId}`);

  // a pretend unsigned withdrawal tx (any bytes; mock ignores txData)
  const message = ethers.hexlify(ethers.randomBytes(120));
  const spender = ethers.Wallet.createRandom();
  const reqHash = await committee.requestHash(asset, accountId, message);
  const spenderSig = await spender.signMessage(ethers.getBytes(reqHash));

  // (2) confidential sign (view / eth_call)
  const [encAddr, r, s, v] = await committee.sign(asset, accountId, message, spenderSig);
  const detOk = encAddr.toLowerCase() === addr.toLowerCase();
  const recovered = ethers.recoverAddress(ethers.keccak256(message), { r, s, v: Number(v) });
  const sigOk = recovered.toLowerCase() === encAddr.toLowerCase();
  console.log(`\nsign() -> encAddr=${encAddr} v=${v}`);
  console.log(`  1. address deterministic (== encumberedAccount): ${detOk ? "✅" : "❌"}`);
  console.log(`  2. signature recovers to derived address:        ${sigOk ? "✅" : "❌"} (recovered ${recovered})`);

  // (3) canSign gating
  await (await mock.setAllow(false)).wait();
  let gateOk = false;
  try {
    await committee.sign(asset, accountId, message, spenderSig);
  } catch (e) {
    gateOk = /canSign/.test(e.shortMessage || e.message || "");
  }
  await (await mock.setAllow(true)).wait();
  console.log(`  3. reverts when canSign=false:                   ${gateOk ? "✅" : "❌"}`);

  // (4) wrong spender rejected when the policy pins an allowed spender
  await (await mock.setAllowedSpender(spender.address)).wait();
  const intruder = ethers.Wallet.createRandom();
  const intruderSig = await intruder.signMessage(ethers.getBytes(reqHash));
  let pinOk = false;
  try {
    await committee.sign(asset, accountId, message, intruderSig);
  } catch (e) {
    pinOk = /canSign/.test(e.shortMessage || e.message || "");
  }
  // the original (correct) spender still works
  const [encAddr2] = await committee.sign(asset, accountId, message, spenderSig);
  console.log(`  4. foreign spender rejected, real spender ok:    ${pinOk && encAddr2.toLowerCase() === addr.toLowerCase() ? "✅" : "❌"}`);

  const allOk = detOk && sigOk && gateOk && pinOk;
  console.log(`\n${allOk ? "✅ ALL CHECKS PASSED — the Sapphire contract is a working signing committee" : "❌ some checks failed"}`);
  process.exitCode = allOk ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
