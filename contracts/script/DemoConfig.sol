// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

string constant FORWARDER_NAME = "BlockwardenForwarder";

bytes32 constant FORWARDER_SALT = keccak256("blockwarden.demo.forwarder");
bytes32 constant EMITTER_SALT = keccak256("blockwarden.demo.emitter");
bytes32 constant VAULT_SALT = keccak256("blockwarden.demo.vault");

// accounting units, not wei: the vault holds no ETH
uint256 constant DEFAULT_THRESHOLD = 100;
uint256 constant DEFAULT_TOP_UP_AMOUNT = 500;
// seconds
uint256 constant DEFAULT_COOLDOWN = 3600;
