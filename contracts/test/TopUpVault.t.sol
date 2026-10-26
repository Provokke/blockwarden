// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {FORWARDER_NAME} from "../script/DemoConfig.sol";
import {TopUpVault} from "../src/TopUpVault.sol";
import {ForwardRequests} from "./utils/ForwardRequests.sol";

contract TopUpVaultTest is Test, ForwardRequests {
    event Funded(uint256 amount);
    event Spent(address indexed account, uint256 amount);
    event BalanceLow(address indexed account, uint256 balance);
    event ToppedUp(address indexed account, address indexed by, uint256 amount);

    uint256 internal constant THRESHOLD = 100;
    uint256 internal constant TOP_UP = 500;
    uint256 internal constant COOLDOWN = 1 hours;
    // Foundry's clock starts at 1, which is inside the first cooldown; a real chain's is decades past it
    uint256 internal constant START = 1_750_000_000;
    uint256 internal constant SIGNER_KEY = 0xB0B;

    ERC2771Forwarder internal forwarder;
    TopUpVault internal vault;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        vm.warp(START);
        forwarder = new ERC2771Forwarder(FORWARDER_NAME);
        vault = new TopUpVault(address(forwarder), owner, THRESHOLD, TOP_UP, COOLDOWN);
    }

    function fundPool(uint256 amount) internal {
        vm.prank(owner);
        vault.fund(amount);
    }

    function creditAlice() internal {
        fundPool(TOP_UP);
        vault.topUp(alice);
    }

    function balanceLowCount(Vm.Log[] memory logs) internal view returns (uint256 count) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == BalanceLow.selector) ++count;
        }
    }

    function test_constructorSetsItsParameters() public view {
        assertEq(vault.threshold(), THRESHOLD);
        assertEq(vault.topUpAmount(), TOP_UP);
        assertEq(vault.cooldown(), COOLDOWN);
        assertEq(vault.owner(), owner);
        assertEq(vault.trustedForwarder(), address(forwarder));
        assertEq(vault.pool(), 0);
    }

    function test_holdsNoEth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 wei}("");
        assertFalse(ok);
        assertEq(address(vault).balance, 0);
    }

    function test_fundAddsToThePool() public {
        vm.expectEmit(address(vault));
        emit Funded(700);
        fundPool(700);
        fundPool(300);
        assertEq(vault.pool(), 1000);
    }

    function test_fundIsOwnerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        vault.fund(1);
    }

    function test_spendBurnsFromTheCallerAndEmitsSpent() public {
        creditAlice();
        vm.expectEmit(address(vault));
        emit Spent(alice, 150);
        vm.prank(alice);
        vault.spend(150);
        assertEq(vault.balanceOf(alice), TOP_UP - 150);
    }

    function test_spendRevertsOnAShortBalance() public {
        creditAlice();
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.InsufficientBalance.selector, TOP_UP, TOP_UP + 1));
        vm.prank(alice);
        vault.spend(TOP_UP + 1);
    }

    function test_spendRevertsForAnAccountWithNoBalance() public {
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.InsufficientBalance.selector, 0, 1));
        vm.prank(bob);
        vault.spend(1);
    }

    function test_spendOfTheWholeBalanceLeavesZero() public {
        creditAlice();
        vm.prank(alice);
        vault.spend(TOP_UP);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_balanceLowIsEmittedWhenASpendCrossesBelowTheThreshold() public {
        creditAlice();
        vm.expectEmit(address(vault));
        emit Spent(alice, TOP_UP - THRESHOLD + 1);
        vm.expectEmit(address(vault));
        emit BalanceLow(alice, THRESHOLD - 1);
        vm.prank(alice);
        vault.spend(TOP_UP - THRESHOLD + 1);
    }

    function test_balanceLowIsNotEmittedWhenASpendStopsAtTheThreshold() public {
        creditAlice();
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(TOP_UP - THRESHOLD);
        assertEq(balanceLowCount(vm.getRecordedLogs()), 0);
        assertEq(vault.balanceOf(alice), THRESHOLD);
    }

    function test_balanceLowIsNotEmittedWhenASpendStaysAbove() public {
        creditAlice();
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(1);
        assertEq(balanceLowCount(vm.getRecordedLogs()), 0);
    }

    function test_balanceLowIsNotEmittedForASpendThatStartsBelow() public {
        creditAlice();
        vm.prank(alice);
        vault.spend(TOP_UP - 10);
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(5);
        assertEq(balanceLowCount(vm.getRecordedLogs()), 0);
        assertEq(vault.balanceOf(alice), 5);
    }

    function test_balanceLowIsEmittedForASpendFromExactlyTheThreshold() public {
        creditAlice();
        vm.prank(alice);
        vault.spend(TOP_UP - THRESHOLD);
        vm.expectEmit(address(vault));
        emit BalanceLow(alice, THRESHOLD - 1);
        vm.prank(alice);
        vault.spend(1);
    }

    function test_topUpCreditsFromThePoolAndNamesTheCaller() public {
        fundPool(1000);
        vm.expectEmit(address(vault));
        emit ToppedUp(alice, bob, TOP_UP);
        vm.prank(bob);
        vault.topUp(alice);
        assertEq(vault.balanceOf(alice), TOP_UP);
        assertEq(vault.pool(), 1000 - TOP_UP);
        assertEq(vault.lastTopUp(alice), START);
    }

    function test_topUpRevertsOnAnEmptyPool() public {
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.PoolTooLow.selector, 0, TOP_UP));
        vault.topUp(alice);
    }

    function test_topUpRevertsOnAPoolShortOfOneTopUp() public {
        fundPool(TOP_UP - 1);
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.PoolTooLow.selector, TOP_UP - 1, TOP_UP));
        vault.topUp(alice);
    }

    function test_topUpPassesExactlyAtTheEndOfTheCooldown() public {
        fundPool(2 * TOP_UP);
        vault.topUp(alice);
        vm.warp(START + COOLDOWN);
        vault.topUp(alice);
        assertEq(vault.balanceOf(alice), 2 * TOP_UP);
        assertEq(vault.lastTopUp(alice), START + COOLDOWN);
    }

    function test_topUpRevertsOneSecondBeforeTheEndOfTheCooldown() public {
        fundPool(2 * TOP_UP);
        vault.topUp(alice);
        vm.warp(START + COOLDOWN - 1);
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.CooldownActive.selector, alice, START + COOLDOWN));
        vault.topUp(alice);
    }

    function test_eachAccountHasItsOwnCooldown() public {
        fundPool(2 * TOP_UP);
        vault.topUp(alice);
        vault.topUp(bob);
        assertEq(vault.balanceOf(bob), TOP_UP);
    }

    function test_topUpThroughTheForwarderIsAttributedToTheSigner() public {
        fundPool(TOP_UP);
        address signer = vm.addr(SIGNER_KEY);
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(vault),
            abi.encodeCall(TopUpVault.topUp, (signer)),
            uint48(block.timestamp + 1 hours)
        );
        vm.expectEmit(address(vault));
        emit ToppedUp(signer, signer, TOP_UP);
        vm.prank(relayer);
        forwarder.execute(request);
        assertEq(vault.balanceOf(signer), TOP_UP);
    }

    function test_spendThroughTheForwarderBurnsTheSignersBalance() public {
        address signer = vm.addr(SIGNER_KEY);
        fundPool(TOP_UP);
        vault.topUp(signer);
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(vault),
            abi.encodeCall(TopUpVault.spend, (TOP_UP)),
            uint48(block.timestamp + 1 hours)
        );
        vm.expectEmit(address(vault));
        emit Spent(signer, TOP_UP);
        vm.prank(relayer);
        forwarder.execute(request);
        assertEq(vault.balanceOf(signer), 0);
        assertEq(vault.balanceOf(relayer), 0);
    }

    function test_fundThroughTheForwarderNeedsTheOwnersSignature() public {
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(vault),
            abi.encodeCall(TopUpVault.fund, (1)),
            uint48(block.timestamp + 1 hours)
        );
        // the forwarder reports any failed call as FailedCall; the vault's own error does not surface
        vm.expectRevert(Errors.FailedCall.selector);
        vm.prank(relayer);
        forwarder.execute(request);
        assertEq(forwarder.nonces(vm.addr(SIGNER_KEY)), 0);
    }

    function test_aForwardedTopUpInsideTheCooldownRevertsAndKeepsItsNonce() public {
        address signer = vm.addr(SIGNER_KEY);
        fundPool(2 * TOP_UP);
        vault.topUp(signer);
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(vault),
            abi.encodeCall(TopUpVault.topUp, (signer)),
            uint48(block.timestamp + 1 hours)
        );
        vm.expectRevert(Errors.FailedCall.selector);
        forwarder.execute(request);
        assertEq(forwarder.nonces(signer), 0);
    }

    function test_anExecutedRequestCannotBeReplayed() public {
        address signer = vm.addr(SIGNER_KEY);
        fundPool(2 * TOP_UP);
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(vault),
            abi.encodeCall(TopUpVault.topUp, (signer)),
            uint48(block.timestamp + 2 hours)
        );
        forwarder.execute(request);
        vm.warp(START + COOLDOWN);
        // the nonce moved on, so the same signature now recovers to some other address
        vm.expectPartialRevert(ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector);
        forwarder.execute(request);
        assertEq(vault.balanceOf(signer), TOP_UP);
    }

    function testFuzz_spendLeavesTheRestAndReportsALowBalance(uint256 amount) public {
        amount = bound(amount, 0, TOP_UP);
        creditAlice();
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(amount);
        uint256 remaining = TOP_UP - amount;
        assertEq(vault.balanceOf(alice), remaining);
        assertEq(balanceLowCount(vm.getRecordedLogs()), remaining < THRESHOLD ? 1 : 0);
    }

    function testFuzz_balanceLowIsEmittedOnlyOnTheSpendThatCrosses(uint256 first, uint256 second) public {
        first = bound(first, 0, TOP_UP);
        second = bound(second, 0, TOP_UP - first);
        creditAlice();
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(first);
        uint256 afterFirst = TOP_UP - first;
        assertEq(balanceLowCount(vm.getRecordedLogs()), afterFirst < THRESHOLD ? 1 : 0);
        vm.recordLogs();
        vm.prank(alice);
        vault.spend(second);
        uint256 afterSecond = afterFirst - second;
        assertEq(balanceLowCount(vm.getRecordedLogs()), afterFirst >= THRESHOLD && afterSecond < THRESHOLD ? 1 : 0);
    }

    function testFuzz_spendPastTheBalanceReverts(uint256 amount) public {
        amount = bound(amount, TOP_UP + 1, type(uint256).max);
        creditAlice();
        vm.expectRevert(abi.encodeWithSelector(TopUpVault.InsufficientBalance.selector, TOP_UP, amount));
        vm.prank(alice);
        vault.spend(amount);
    }

    function testFuzz_fundAccumulates(uint128 first, uint128 second) public {
        fundPool(first);
        fundPool(second);
        assertEq(vault.pool(), uint256(first) + second);
    }

    function testFuzz_aSecondTopUpWaitsForTheCooldown(uint256 cooldown, uint256 elapsed) public {
        cooldown = bound(cooldown, 1, 365 days);
        elapsed = bound(elapsed, 0, 2 * cooldown);
        TopUpVault fuzzed = new TopUpVault(address(forwarder), owner, THRESHOLD, TOP_UP, cooldown);
        vm.prank(owner);
        fuzzed.fund(2 * TOP_UP);
        fuzzed.topUp(alice);
        vm.warp(START + elapsed);
        if (elapsed < cooldown) {
            vm.expectRevert(abi.encodeWithSelector(TopUpVault.CooldownActive.selector, alice, START + cooldown));
        }
        fuzzed.topUp(alice);
    }

    function testFuzz_thePoolBoundsHowManyTopUpsSucceed(uint256 funded) public {
        funded = bound(funded, 0, 10 * TOP_UP);
        fundPool(funded);
        uint256 credited;
        for (uint256 i; i < 11; ++i) {
            try vault.topUp(address(uint160(0x1000 + i))) {
                ++credited;
            } catch {}
        }
        assertEq(credited, funded / TOP_UP);
        assertEq(vault.pool(), funded - credited * TOP_UP);
    }
}
