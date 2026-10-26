// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Context} from "@openzeppelin/contracts/utils/Context.sol";

/// @notice Keeps balances in accounting units, not ETH, so a copy on a public testnet holds nothing worth taking.
/// The pool and the cooldown are what bound `topUp`, which is why anyone may call it: a rule can relay a fixed
/// `topUp(account)`, and a signed forward request can top up its own signer.
contract TopUpVault is ERC2771Context, Ownable {
    uint256 public immutable threshold;
    uint256 public immutable topUpAmount;
    uint256 public immutable cooldown;

    uint256 public pool;
    mapping(address account => uint256) public balanceOf;
    mapping(address account => uint256) public lastTopUp;

    event Funded(uint256 amount);
    event Spent(address indexed account, uint256 amount);
    event BalanceLow(address indexed account, uint256 balance);
    event ToppedUp(address indexed account, address indexed by, uint256 amount);

    error InsufficientBalance(uint256 balance, uint256 amount);
    error CooldownActive(address account, uint256 availableAt);
    error PoolTooLow(uint256 pool, uint256 amount);

    constructor(
        address trustedForwarder_,
        address initialOwner,
        uint256 threshold_,
        uint256 topUpAmount_,
        uint256 cooldown_
    ) ERC2771Context(trustedForwarder_) Ownable(initialOwner) {
        threshold = threshold_;
        topUpAmount = topUpAmount_;
        cooldown = cooldown_;
    }

    function fund(uint256 amount) external onlyOwner {
        pool += amount;
        emit Funded(amount);
    }

    function spend(uint256 amount) external {
        address account = _msgSender();
        uint256 balance = balanceOf[account];
        if (balance < amount) revert InsufficientBalance(balance, amount);
        uint256 remaining = balance - amount;
        balanceOf[account] = remaining;
        emit Spent(account, amount);
        // only the spend that takes the balance under the threshold reports it: a rule that tops up on this event
        // would otherwise fire on every later spend, and a top-up inside the cooldown can only revert
        if (balance >= threshold && remaining < threshold) emit BalanceLow(account, remaining);
    }

    function topUp(address account) external {
        uint256 availableAt = lastTopUp[account] + cooldown;
        if (block.timestamp < availableAt) revert CooldownActive(account, availableAt);
        uint256 amount = topUpAmount;
        uint256 available = pool;
        if (available < amount) revert PoolTooLow(available, amount);
        pool = available - amount;
        balanceOf[account] += amount;
        lastTopUp[account] = block.timestamp;
        emit ToppedUp(account, _msgSender(), amount);
    }

    function _msgSender() internal view override(Context, ERC2771Context) returns (address) {
        return ERC2771Context._msgSender();
    }

    function _msgData() internal view override(Context, ERC2771Context) returns (bytes calldata) {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength() internal view override(Context, ERC2771Context) returns (uint256) {
        return ERC2771Context._contextSuffixLength();
    }
}
