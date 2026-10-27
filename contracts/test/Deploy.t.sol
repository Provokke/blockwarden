// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";
import {EMITTER_SALT, FORWARDER_NAME, FORWARDER_SALT, VAULT_SALT} from "../script/DemoConfig.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {DemoEmitter} from "../src/DemoEmitter.sol";
import {TopUpVault} from "../src/TopUpVault.sol";

contract DeployTest is Test {
    Deploy internal script;
    Deploy.Params internal params;

    function setUp() public {
        script = new Deploy();
        params = Deploy.Params({owner: makeAddr("owner"), threshold: 100, topUpAmount: 500, cooldown: 3600});
    }

    function test_deploysEachContractAtItsCreate2AddressThroughTheFactory() public {
        Deploy.Deployed memory deployed = script.deploy(params);
        assertEq(
            deployed.forwarder,
            vm.computeCreate2Address(FORWARDER_SALT, keccak256(script.forwarderInitCode()), CREATE2_FACTORY)
        );
        assertEq(
            deployed.emitter,
            vm.computeCreate2Address(
                EMITTER_SALT, keccak256(script.emitterInitCode(deployed.forwarder)), CREATE2_FACTORY
            )
        );
        assertEq(
            deployed.vault,
            vm.computeCreate2Address(
                VAULT_SALT, keccak256(script.vaultInitCode(deployed.forwarder, params)), CREATE2_FACTORY
            )
        );
        assertGt(deployed.forwarder.code.length, 0);
        assertGt(deployed.emitter.code.length, 0);
        assertGt(deployed.vault.code.length, 0);
    }

    function test_wiresTheContractsTogether() public {
        Deploy.Deployed memory deployed = script.deploy(params);
        (, string memory name, string memory version,, address verifyingContract,,) =
            ERC2771Forwarder(deployed.forwarder).eip712Domain();
        assertEq(name, FORWARDER_NAME);
        assertEq(version, "1");
        assertEq(verifyingContract, deployed.forwarder);
        assertEq(DemoEmitter(deployed.emitter).trustedForwarder(), deployed.forwarder);
        TopUpVault vault = TopUpVault(deployed.vault);
        assertEq(vault.trustedForwarder(), deployed.forwarder);
        assertEq(vault.owner(), params.owner);
        assertEq(vault.threshold(), params.threshold);
        assertEq(vault.topUpAmount(), params.topUpAmount);
        assertEq(vault.cooldown(), params.cooldown);
    }

    function test_leavesTheVaultUnfunded() public {
        Deploy.Deployed memory deployed = script.deploy(params);
        assertEq(TopUpVault(deployed.vault).pool(), 0);
    }

    function test_givesTheSameAddressesOnAnotherChain() public {
        uint256 clean = vm.snapshotState();
        vm.chainId(31337);
        Deploy.Deployed memory local = script.deploy(params);
        vm.revertToState(clean);
        vm.chainId(84532);
        Deploy.Deployed memory other = script.deploy(params);
        assertEq(other.forwarder, local.forwarder);
        assertEq(other.emitter, local.emitter);
        assertEq(other.vault, local.vault);
    }

    function test_aSecondRunReusesWhatIsAlreadyDeployed() public {
        Deploy.Deployed memory first = script.deploy(params);
        Deploy.Deployed memory second = script.deploy(params);
        assertEq(second.forwarder, first.forwarder);
        assertEq(second.emitter, first.emitter);
        assertEq(second.vault, first.vault);
    }

    function test_anotherOwnerIsAnotherVault() public {
        Deploy.Deployed memory first = script.deploy(params);
        params.owner = makeAddr("someone else");
        Deploy.Deployed memory second = script.deploy(params);
        assertEq(second.forwarder, first.forwarder);
        assertEq(second.emitter, first.emitter);
        assertTrue(second.vault != first.vault);
    }

    function test_writesTheAddressesAndParameters() public {
        Deploy.Deployed memory deployed = script.deploy(params);
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        string memory path = string.concat(vm.projectRoot(), "/deployments/deploy-test.json");
        script.write(params, deployed, path);
        string memory json = vm.readFile(path);
        vm.removeFile(path);
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
        assertEq(vm.parseJsonString(json, ".forwarderName"), FORWARDER_NAME);
        assertEq(vm.parseJsonAddress(json, ".forwarder"), deployed.forwarder);
        assertEq(vm.parseJsonAddress(json, ".emitter"), deployed.emitter);
        assertEq(vm.parseJsonAddress(json, ".vault"), deployed.vault);
        assertEq(vm.parseJsonAddress(json, ".owner"), params.owner);
        assertEq(vm.parseJsonString(json, ".threshold"), "100");
        assertEq(vm.parseJsonString(json, ".topUpAmount"), "500");
        assertEq(vm.parseJsonString(json, ".cooldown"), "3600");
    }
}
