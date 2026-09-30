// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {DemoEmitter} from "../src/DemoEmitter.sol";
import {TopUpVault} from "../src/TopUpVault.sol";
import {
    ANVIL_ACCOUNT_0,
    DEFAULT_COOLDOWN,
    DEFAULT_THRESHOLD,
    DEFAULT_TOP_UP_AMOUNT,
    EMITTER_SALT,
    FORWARDER_NAME,
    FORWARDER_SALT,
    LOCAL_CHAIN_ID,
    VAULT_SALT
} from "./DemoConfig.sol";

/// @notice Deploys the forwarder, the emitter and the vault through the deterministic CREATE2 factory, so the same
/// inputs give the same addresses on every chain. It never funds the vault: that is Fund.s.sol, run by the owner,
/// so a second run of this script cannot refund anything.
contract Deploy is Script {
    struct Params {
        address owner;
        uint256 threshold;
        uint256 topUpAmount;
        uint256 cooldown;
    }

    struct Deployed {
        address forwarder;
        address emitter;
        address vault;
    }

    error Create2Failed(bytes32 salt);
    error OwnerIsAnvilAccount();

    function run() external returns (Deployed memory deployed) {
        // the owner is part of the vault's init code, so a chain given another owner gets another vault address. Only
        // Anvil may fall back to the sender: everywhere else the owner must be named, and must not be Anvil's
        // first account, whose key is public.
        address owner;
        if (block.chainid == LOCAL_CHAIN_ID) {
            owner = vm.envOr("VAULT_OWNER", msg.sender);
        } else {
            owner = vm.envAddress("VAULT_OWNER");
            if (owner == ANVIL_ACCOUNT_0) revert OwnerIsAnvilAccount();
        }
        Params memory params = Params({
            owner: owner,
            threshold: vm.envOr("VAULT_THRESHOLD", DEFAULT_THRESHOLD),
            topUpAmount: vm.envOr("VAULT_TOP_UP_AMOUNT", DEFAULT_TOP_UP_AMOUNT),
            cooldown: vm.envOr("VAULT_COOLDOWN", DEFAULT_COOLDOWN)
        });
        vm.startBroadcast();
        deployed = deploy(params);
        vm.stopBroadcast();
        // a dry run must not overwrite a committed file with addresses that were never deployed
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            string memory dir = string.concat(vm.projectRoot(), "/deployments");
            vm.createDir(dir, true);
            write(params, deployed, string.concat(dir, "/", vm.toString(block.chainid), ".json"));
        }
    }

    function deploy(Params memory params) public returns (Deployed memory deployed) {
        deployed.forwarder = create2(FORWARDER_SALT, forwarderInitCode());
        deployed.emitter = create2(EMITTER_SALT, emitterInitCode(deployed.forwarder));
        deployed.vault = create2(VAULT_SALT, vaultInitCode(deployed.forwarder, params));
    }

    function forwarderInitCode() public pure returns (bytes memory) {
        return abi.encodePacked(type(ERC2771Forwarder).creationCode, abi.encode(FORWARDER_NAME));
    }

    function emitterInitCode(address forwarder) public pure returns (bytes memory) {
        return abi.encodePacked(type(DemoEmitter).creationCode, abi.encode(forwarder));
    }

    function vaultInitCode(address forwarder, Params memory params) public pure returns (bytes memory) {
        return abi.encodePacked(
            type(TopUpVault).creationCode,
            abi.encode(forwarder, params.owner, params.threshold, params.topUpAmount, params.cooldown)
        );
    }

    function write(Params memory params, Deployed memory deployed, string memory path) public {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeString(key, "forwarderName", FORWARDER_NAME);
        vm.serializeAddress(key, "forwarder", deployed.forwarder);
        vm.serializeAddress(key, "emitter", deployed.emitter);
        vm.serializeAddress(key, "vault", deployed.vault);
        vm.serializeAddress(key, "owner", params.owner);
        // decimal strings, as every other amount in this repository is, so a reader never meets a number past 2^53
        vm.serializeString(key, "threshold", vm.toString(params.threshold));
        vm.serializeString(key, "topUpAmount", vm.toString(params.topUpAmount));
        string memory json = vm.serializeString(key, "cooldown", vm.toString(params.cooldown));
        vm.writeJson(json, path);
    }

    // the same transaction ts/testing.ts sends: the salt, then the init code, to the factory Anvil and the chains the
    // demo targets already carry. Where it is missing the call fails safely with Create2Failed. An address that already
    // has code is left as it is, so a second run changes nothing.
    function create2(bytes32 salt, bytes memory initCode) internal returns (address deployed) {
        deployed = vm.computeCreate2Address(salt, keccak256(initCode));
        if (deployed.code.length > 0) return deployed;
        (bool ok, bytes memory returned) = CREATE2_FACTORY.call(abi.encodePacked(salt, initCode));
        if (!ok || returned.length != 20 || address(bytes20(returned)) != deployed) revert Create2Failed(salt);
    }
}
