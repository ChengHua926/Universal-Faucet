// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IBridgeOracle} from "./IBridgeOracle.sol";

interface IAccountAwareBridgeOracle {
    function getTransactionCostForAccount(
        bytes calldata unsignedTx,
        bytes32 encAccount
    ) external view returns (uint256 maxCost);
}

/**
 * @title CrossroadsAssetContract
 * @dev Chain-agnostic asset contract for deposits, spending authorization, and
 * withdrawal finalization. Chain-specific transaction parsing lives in the
 * bridge oracle.
 */
contract CrossroadsAssetContract is ERC20, ReentrancyGuard, Ownable {
    uint8 public constant SCHEME_ECDSA_SECP256K1 = 1;

    IBridgeOracle public bridgeOracle;
    uint8 private immutable _signatureScheme;

    mapping(bytes32 => bool) public isEncumberedAccount;
    mapping(bytes32 => uint256) public accountEpoch;

    mapping(bytes32 => bool) public processedDeposits;
    mapping(bytes32 => bool) public processedWithdrawals;

    // Spender funds burned into the right to spend from a specific encumbered account.
    mapping(address => mapping(bytes32 => uint256)) public spendingBalance;
    mapping(address => mapping(bytes32 => bool)) public spendingBalanceBlocked;
    mapping(address => mapping(bytes32 => uint256)) public spendingBalanceBlockedAtEpoch;

    // Native backend-chain funds shared across a spender's active encumbered accounts.
    mapping(address => uint256) public withdrawalProofSubsidy;
    mapping(address => uint256) public activeWithdrawalAccountCount;
    uint256 public withdrawalProofReward;

    event DepositProcessed(address indexed sender, bytes32 indexed destination, uint256 amount, bytes32 indexed txHash);
    event SpendingBalanceIncreased(
        address indexed spender,
        bytes32 indexed encAccount,
        uint256 amount,
        uint256 totalSpendingBalance
    );
    event SpendingBalanceBlocked(address indexed spender, bytes32 indexed encAccount, uint256 blockedAtEpoch);
    event SpendingBalanceUnblocked(address indexed spender, bytes32 indexed encAccount);
    event SpendingBalanceWithdrawn(address indexed spender, bytes32 indexed encAccount, uint256 amount);
    event WithdrawalProofSubsidyFunded(address indexed spender, uint256 amount, uint256 totalSubsidy);
    event WithdrawalProofSubsidyWithdrawn(address indexed spender, uint256 amount, uint256 remainingSubsidy);
    event WithdrawalFinalized(
        address indexed spender,
        bytes32 indexed encAccount,
        uint256 amountSpent,
        uint256 withdrawalProofRewardPaid,
        bytes32 indexed txHash
    );
    event WithdrawalInconsistency(
        address indexed spender,
        bytes32 indexed encAccount,
        bytes32 indexed txHash,
        uint256 amountSpendable,
        uint256 amountSpent
    );
    event EpochAdvanced(bytes32 indexed encAccount, uint256 newEpoch);
    event EncumberedAccountRegistered(bytes32 indexed encAccount);
    event EncumberedAccountRemoved(bytes32 indexed encAccount);
    event WithdrawalProofRewardChanged(uint256 newReward);

    function signatureScheme() external view returns (uint8) {
        return _signatureScheme;
    }

    constructor(
        string memory _name,
        string memory _symbol,
        address _bridgeOracle,
        uint8 signatureScheme_,
        uint256 _withdrawalProofReward
    ) ERC20(_name, _symbol) Ownable(msg.sender) {
        bridgeOracle = IBridgeOracle(_bridgeOracle);
        _signatureScheme = signatureScheme_;
        withdrawalProofReward = _withdrawalProofReward;
    }

    function registerEncumberedAccount(bytes32 encAddr) external onlyOwner {
        require(!isEncumberedAccount[encAddr], "Already registered");
        isEncumberedAccount[encAddr] = true;
        emit EncumberedAccountRegistered(encAddr);
    }

    function removeEncumberedAccount(bytes32 encAddr) external onlyOwner {
        require(isEncumberedAccount[encAddr], "Not registered");
        isEncumberedAccount[encAddr] = false;
        emit EncumberedAccountRemoved(encAddr);
    }

    function deposit(bytes calldata signedTx, bytes calldata proof) external nonReentrant {
        (address sender, bytes32 destination, uint256 amount, bytes32 txHash) =
            bridgeOracle.verifyDeposit(signedTx, proof);
        require(!processedDeposits[txHash], "Deposit already processed");
        processedDeposits[txHash] = true;

        require(isEncumberedAccount[destination], "Destination not encumbered");

        uint256 currentEpoch = accountEpoch[destination];
        uint256 nextEpoch = bridgeOracle.getDepositEpoch(signedTx, proof, destination, currentEpoch);
        accountEpoch[destination] = nextEpoch;

        _mint(sender, amount);
        emit DepositProcessed(sender, destination, amount, txHash);
    }

    function fundWithdrawalProofSubsidy() external payable nonReentrant {
        _fundWithdrawalProofSubsidy(msg.sender, msg.value);
    }

    /**
     * @notice Burn wrapped tokens into spending balance for an encumbered
     * account. Attached native funds are added to the spender's shared proof
     * subsidy.
     */
    function lockWithdrawal(
        uint256 amount,
        bytes32 encAccount
    ) external payable nonReentrant returns (uint256 totalSpendingBalance) {
        _fundWithdrawalProofSubsidy(msg.sender, msg.value);
        totalSpendingBalance = _increaseSpendingBalance(msg.sender, encAccount, amount);
    }

    function increaseSpendingBalance(
        uint256 amount,
        bytes32 encAccount
    ) external nonReentrant returns (uint256 totalSpendingBalance) {
        totalSpendingBalance = _increaseSpendingBalance(msg.sender, encAccount, amount);
    }

    function blockSpendingBalance(bytes32 encAccount) external nonReentrant {
        require(spendingBalance[msg.sender][encAccount] > 0, "No spending balance");
        require(!spendingBalanceBlocked[msg.sender][encAccount], "Already blocked");

        spendingBalanceBlocked[msg.sender][encAccount] = true;
        spendingBalanceBlockedAtEpoch[msg.sender][encAccount] = accountEpoch[encAccount];
        activeWithdrawalAccountCount[msg.sender] -= 1;

        emit SpendingBalanceBlocked(msg.sender, encAccount, accountEpoch[encAccount]);
    }

    function unblockSpendingBalance(bytes32 encAccount) external nonReentrant {
        require(spendingBalanceBlocked[msg.sender][encAccount], "Not blocked");

        spendingBalanceBlocked[msg.sender][encAccount] = false;
        spendingBalanceBlockedAtEpoch[msg.sender][encAccount] = 0;
        if (spendingBalance[msg.sender][encAccount] > 0) {
            activeWithdrawalAccountCount[msg.sender] += 1;
        }

        emit SpendingBalanceUnblocked(msg.sender, encAccount);
    }

    function withdrawSpendingBalance(bytes32 encAccount, uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(spendingBalanceBlocked[msg.sender][encAccount], "Spending balance not blocked");
        require(
            accountEpoch[encAccount] > spendingBalanceBlockedAtEpoch[msg.sender][encAccount],
            "Epoch not advanced"
        );

        uint256 balance = spendingBalance[msg.sender][encAccount];
        require(balance >= amount, "Insufficient spending balance");

        spendingBalance[msg.sender][encAccount] = balance - amount;
        if (spendingBalance[msg.sender][encAccount] == 0) {
            spendingBalanceBlocked[msg.sender][encAccount] = false;
            spendingBalanceBlockedAtEpoch[msg.sender][encAccount] = 0;
        }

        _mint(msg.sender, amount);
        emit SpendingBalanceWithdrawn(msg.sender, encAccount, amount);
    }

    function withdrawWithdrawalProofSubsidy(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        uint256 subsidy = withdrawalProofSubsidy[msg.sender];
        require(subsidy >= amount, "Insufficient proof subsidy");

        uint256 remaining = subsidy - amount;
        require(remaining >= requiredWithdrawalProofSubsidy(msg.sender), "Active withdrawals need subsidy");

        withdrawalProofSubsidy[msg.sender] = remaining;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");

        emit WithdrawalProofSubsidyWithdrawn(msg.sender, amount, remaining);
    }

    function finalizeWithdrawal(
        bytes calldata signedTx,
        bytes calldata proof,
        bytes32 encAccount
    ) external nonReentrant {
        bytes32 txHash = bridgeOracle.getTransactionHash(signedTx);
        require(!processedWithdrawals[txHash], "Withdrawal already processed");

        uint256 currentEpoch = accountEpoch[encAccount];
        (bytes32 encAccountSigned, address spender, uint256 amountSpent, ) = bridgeOracle.verifyWithdrawal(
            signedTx,
            proof,
            encAccount,
            currentEpoch
        );
        require(encAccountSigned == encAccount, "Encumbered account signer mismatch");

        processedWithdrawals[txHash] = true;

        uint256 nextEpoch = bridgeOracle.getWithdrawalEpoch(signedTx, proof, encAccount, currentEpoch);
        accountEpoch[encAccount] = nextEpoch;
        emit EpochAdvanced(encAccount, nextEpoch);

        uint256 withdrawalProofRewardPaid = Math.min(withdrawalProofSubsidy[spender], withdrawalProofReward);
        if (withdrawalProofRewardPaid > 0) {
            withdrawalProofSubsidy[spender] -= withdrawalProofRewardPaid;
            (bool ok, ) = payable(msg.sender).call{value: withdrawalProofRewardPaid}("");
            if (!ok) {
                withdrawalProofSubsidy[spender] += withdrawalProofRewardPaid;
                withdrawalProofRewardPaid = 0;
            }
        }

        uint256 balance = spendingBalance[spender][encAccount];
        if (balance < amountSpent) {
            emit WithdrawalInconsistency(spender, encAccount, txHash, balance, amountSpent);
        }

        uint256 spent = Math.min(balance, amountSpent);
        if (spent > 0) {
            spendingBalance[spender][encAccount] = balance - spent;
            if (spendingBalance[spender][encAccount] == 0) {
                if (!spendingBalanceBlocked[spender][encAccount] && activeWithdrawalAccountCount[spender] > 0) {
                    activeWithdrawalAccountCount[spender] -= 1;
                }
                spendingBalanceBlocked[spender][encAccount] = false;
                spendingBalanceBlockedAtEpoch[spender][encAccount] = 0;
            }
        }

        emit WithdrawalFinalized(spender, encAccount, amountSpent, withdrawalProofRewardPaid, txHash);
    }

    function canSign(address spender, bytes32 encAccount, bytes calldata txData) external view returns (bool) {
        if (!isEncumberedAccount[encAccount]) {
            return false;
        }

        (bool costOk, uint256 transactionCost) = _transactionCost(txData, encAccount);
        if (!costOk) {
            return false;
        }

        // Cost > 0 means the transaction takes value out of the encumbered
        // account (i.e., a withdrawal): the requester must hold sufficient
        // spending balance and have pre-paid the withdrawal-proof subsidy.
        // Cost == 0 means the tx doesn't reduce the encumbered pool — e.g., a
        // consolidation deposit on Bitcoin where the depositor adds inputs and
        // the new encumbered output is strictly larger than the consumed UTXO.
        // For those, anyone may request a signature without a spending balance.
        if (transactionCost > 0) {
            if (spendingBalance[spender][encAccount] == 0 || spendingBalanceBlocked[spender][encAccount]) {
                return false;
            }
            if (withdrawalProofSubsidy[spender] < requiredWithdrawalProofSubsidy(spender)) {
                return false;
            }
            if (transactionCost > spendingBalance[spender][encAccount]) {
                return false;
            }
        }

        try bridgeOracle.isValidForEpoch(txData, encAccount, accountEpoch[encAccount], spender) returns (
            bool valid
        ) {
            return valid;
        } catch {
            return false;
        }
    }

    function _transactionCost(
        bytes calldata txData,
        bytes32 encAccount
    ) private view returns (bool ok, uint256 transactionCost) {
        try IAccountAwareBridgeOracle(address(bridgeOracle)).getTransactionCostForAccount(txData, encAccount) returns (
            uint256 accountAwareCost
        ) {
            return (true, accountAwareCost);
        } catch {
            try bridgeOracle.getTransactionCost(txData) returns (uint256 fallbackCost) {
                return (true, fallbackCost);
            } catch {
                return (false, 0);
            }
        }
    }

    function requiredWithdrawalProofSubsidy(address spender) public view returns (uint256) {
        return activeWithdrawalAccountCount[spender] * withdrawalProofReward;
    }

    function getSpendingPosition(
        address spender,
        bytes32 encAccount
    ) external view returns (uint256 balance, bool blocked, uint256 blockedAtEpoch) {
        return (
            spendingBalance[spender][encAccount],
            spendingBalanceBlocked[spender][encAccount],
            spendingBalanceBlockedAtEpoch[spender][encAccount]
        );
    }

    function setWithdrawalProofReward(uint256 _reward) external onlyOwner {
        withdrawalProofReward = _reward;
        emit WithdrawalProofRewardChanged(_reward);
    }

    function setBridgeOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "Zero address");
        bridgeOracle = IBridgeOracle(_oracle);
    }

    function _fundWithdrawalProofSubsidy(address spender, uint256 amount) private {
        if (amount == 0) {
            return;
        }
        withdrawalProofSubsidy[spender] += amount;
        emit WithdrawalProofSubsidyFunded(spender, amount, withdrawalProofSubsidy[spender]);
    }

    function _increaseSpendingBalance(
        address spender,
        bytes32 encAccount,
        uint256 amount
    ) private returns (uint256 totalSpendingBalance) {
        require(isEncumberedAccount[encAccount], "Encumbered account not registered");
        require(amount > 0, "Zero amount");
        require(!spendingBalanceBlocked[spender][encAccount], "Spending balance blocked");

        if (spendingBalance[spender][encAccount] == 0) {
            activeWithdrawalAccountCount[spender] += 1;
        }

        _burn(spender, amount);
        spendingBalance[spender][encAccount] += amount;

        totalSpendingBalance = spendingBalance[spender][encAccount];
        emit SpendingBalanceIncreased(spender, encAccount, amount, totalSpendingBalance);
    }
}
