// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

string constant FORWARDER_NAME = "BlockwardenForwarder";

// every contract's address comes from its salt and its init code: the compiled bytecode plus the constructor arguments.
// The vault's owner, threshold, top-up amount and cooldown are all constructor arguments, so changing any of them
// gives another vault. The bytecode carries the metadata hash of the sources (bytecode_hash defaults to ipfs), so
// any byte changed in these contracts or in OpenZeppelin, a comment included, moves the addresses too.
uint256 constant LOCAL_CHAIN_ID = 31337;
address constant ANVIL_ACCOUNT_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

bytes32 constant FORWARDER_SALT = keccak256("blockwarden.demo.forwarder");
bytes32 constant EMITTER_SALT = keccak256("blockwarden.demo.emitter");
bytes32 constant VAULT_SALT = keccak256("blockwarden.demo.vault");

// accounting units, not wei: the vault holds no ETH
uint256 constant DEFAULT_THRESHOLD = 100;
uint256 constant DEFAULT_TOP_UP_AMOUNT = 500;
// seconds
uint256 constant DEFAULT_COOLDOWN = 3600;
