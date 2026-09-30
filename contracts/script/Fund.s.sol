// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {TopUpVault} from "../src/TopUpVault.sol";

/// @notice Adds FUND_AMOUNT to the pool of the vault Deploy.s.sol recorded for this chain. It is its own step so that
/// deploying again never funds again.
contract Fund is Script {
    error NothingDeployed(address vault);

    function run() external {
        uint256 amount = vm.envUint("FUND_AMOUNT");
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        TopUpVault vault = TopUpVault(vm.parseJsonAddress(vm.readFile(path), ".vault"));
        if (address(vault).code.length == 0) revert NothingDeployed(address(vault));
        vm.startBroadcast();
        vault.fund(amount);
        vm.stopBroadcast();
    }
}
