// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";
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
} from "../script/DemoConfig.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {Fund} from "../script/Fund.s.sol";
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

    // the environment is process-wide and forge runs test functions in parallel, so every case that sets a variable
    // lives in this one function
    function test_runAndFundReadTheirInputsFromTheEnvironment() public {
        vm.setEnv("VAULT_OWNER", "");
        vm.setEnv("VAULT_THRESHOLD", "");
        vm.setEnv("VAULT_TOP_UP_AMOUNT", "");
        vm.setEnv("VAULT_COOLDOWN", "");

        // Anvil: the owner falls back to the caller and the amounts to the defaults
        vm.chainId(LOCAL_CHAIN_ID);
        Deploy.Deployed memory local = script.run();
        TopUpVault localVault = TopUpVault(local.vault);
        assertEq(localVault.owner(), address(this));
        assertEq(localVault.threshold(), DEFAULT_THRESHOLD);
        assertEq(localVault.topUpAmount(), DEFAULT_TOP_UP_AMOUNT);
        assertEq(localVault.cooldown(), DEFAULT_COOLDOWN);

        // any other chain: no owner, no deploy
        vm.chainId(84532);
        vm.expectRevert();
        script.run();

        // and never Anvil's first account, whose key is public
        vm.setEnv("VAULT_OWNER", vm.toString(ANVIL_ACCOUNT_0));
        vm.expectRevert(Deploy.OwnerIsAnvilAccount.selector);
        script.run();

        vm.setEnv("VAULT_OWNER", vm.toString(params.owner));
        vm.setEnv("VAULT_THRESHOLD", "7");
        Deploy.Deployed memory other = script.run();
        assertEq(TopUpVault(other.vault).owner(), params.owner);
        assertEq(TopUpVault(other.vault).threshold(), 7);
        assertEq(other.forwarder, local.forwarder);
        assertEq(other.emitter, local.emitter);
        assertTrue(other.vault != local.vault);

        // only a broadcast records a deployment; a plain run must not overwrite the file a public chain's deploy commits
        assertFalse(vm.exists("deployments/84532.json"));

        vm.setEnv("VAULT_THRESHOLD", "");
        vm.setEnv("VAULT_OWNER", "");

        checkFundAddsToThePoolOnceAndARedeployLeavesItAlone();
        checkFundRefusesAVaultThatHasNoCode();
    }

    // deploy, fund as the owner, deploy again: the second deploy funds nothing. Chain 424242 keeps the recorded file
    // apart from any 31337.json a developer has.
    function checkFundAddsToThePoolOnceAndARedeployLeavesItAlone() internal {
        vm.chainId(424242);
        vm.setEnv("VAULT_OWNER", vm.toString(DEFAULT_SENDER));
        vm.setEnv("FUND_AMOUNT", "1000");
        vm.setEnv("VAULT_THRESHOLD", "");
        Deploy.Deployed memory deployed = script.run();
        TopUpVault vault = TopUpVault(deployed.vault);
        assertEq(vault.pool(), 0);

        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        string memory path = string.concat(vm.projectRoot(), "/deployments/424242.json");
        script.write(
            Deploy.Params(DEFAULT_SENDER, DEFAULT_THRESHOLD, DEFAULT_TOP_UP_AMOUNT, DEFAULT_COOLDOWN), deployed, path
        );
        new Fund().run();
        assertEq(vault.pool(), 1000);

        Deploy.Deployed memory again = script.run();
        assertEq(again.vault, deployed.vault);
        assertEq(vault.pool(), 1000);

        vm.removeFile(path);
        vm.setEnv("VAULT_OWNER", "");
        vm.setEnv("FUND_AMOUNT", "");
    }

    function checkFundRefusesAVaultThatHasNoCode() internal {
        vm.chainId(424243);
        vm.setEnv("FUND_AMOUNT", "1000");
        vm.createDir(string.concat(vm.projectRoot(), "/deployments"), true);
        string memory path = string.concat(vm.projectRoot(), "/deployments/424243.json");
        script.write(params, Deploy.Deployed(address(1), address(2), address(0xdead)), path);
        Fund fund = new Fund();
        vm.expectRevert(abi.encodeWithSelector(Fund.NothingDeployed.selector, address(0xdead)));
        fund.run();
        vm.removeFile(path);
    }
}
