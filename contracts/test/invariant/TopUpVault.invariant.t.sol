// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";
import {FORWARDER_NAME} from "../../script/DemoConfig.sol";
import {TopUpVault} from "../../src/TopUpVault.sol";
import {VaultHandler} from "./VaultHandler.sol";

contract TopUpVaultInvariantTest is Test {
    ERC2771Forwarder internal forwarder;
    TopUpVault internal vault;
    VaultHandler internal handler;

    function setUp() public {
        forwarder = new ERC2771Forwarder(FORWARDER_NAME);
        address owner = makeAddr("owner");
        vault = new TopUpVault(address(forwarder), owner, 100, 500, 1 hours);
        handler = new VaultHandler(vault, forwarder, owner, 1_750_000_000);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = VaultHandler.warp.selector;
        selectors[1] = VaultHandler.fund.selector;
        selectors[2] = VaultHandler.spend.selector;
        selectors[3] = VaultHandler.topUp.selector;
        selectors[4] = VaultHandler.forwardTopUp.selector;
        selectors[5] = VaultHandler.replayForwarded.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev Drives the handler through every state once, in a fixed order. The fuzzer reaches these states by chance;
    /// this shows the handler is wired to each of them, so a handler that stopped calling the vault cannot pass.
    function test_handlerReachesEveryState() public {
        uint256 unit = vault.topUpAmount();

        handler.fund(1);
        assertGe(handler.ghostFunded(), unit, "fund did not reach the vault");

        handler.topUp(0, 0);
        assertEq(handler.ghostCredited(), unit, "a direct top-up was not credited");

        handler.topUp(0, 0);
        assertEq(handler.refusedByCooldown(), 1, "a top-up inside the cooldown was not refused as such");
        assertEq(handler.ghostCredited(), unit, "a refused top-up was credited");

        // one cooldown on, each pass credits the account and takes from the pool until it cannot pay
        for (uint256 i; i < 6 && vault.pool() >= unit; ++i) {
            handler.warp(1);
            handler.topUp(0, 0);
        }
        assertLt(vault.pool(), unit, "the pool was not drained");
        handler.warp(1);
        handler.topUp(0, 0);
        assertEq(handler.refusedByShortPool(), 1, "a top-up on a short pool was not refused as such");

        handler.fund(1);
        uint256 creditedBefore = handler.ghostCredited();
        handler.forwardTopUp();
        assertEq(handler.ghostForwardedExecutions(), 1, "the forward request did not execute");
        assertEq(handler.ghostCredited(), creditedBefore + unit, "the forwarded top-up was not credited");

        handler.replayForwarded();
        assertEq(handler.replaysRefusedInvalidSigner(), 1, "the replay was not refused for its used nonce");

        // three cooldowns is past the request's deadline of two
        handler.warp(1);
        handler.warp(1);
        handler.warp(1);
        handler.replayForwarded();
        assertEq(handler.replaysRefusedExpired(), 1, "the late replay was not refused as expired");
        assertEq(handler.ghostReplaysAccepted(), 0);

        handler.spend(0, 100);
        assertEq(handler.ghostSpent(), 100, "the spend did not reach the vault");

        invariant_balancesAndSpendingNeverExceedFunding();
        invariant_noAccountIsToppedUpTwiceInsideOneCooldown();
        invariant_anExecutedForwardRequestNeverExecutesAgain();
    }

    /// @dev Invariant 1: nothing is spent or held that was not funded, and the pool is exactly what was not credited.
    function invariant_balancesAndSpendingNeverExceedFunding() public view {
        assertLe(handler.sumOfBalances() + handler.ghostSpent(), handler.ghostFunded());
        // exact, because funding is far too large for the bound above to catch over-crediting
        assertEq(handler.sumOfBalances() + handler.ghostSpent(), handler.ghostCredited());
        assertEq(vault.pool(), handler.ghostFunded() - handler.ghostCredited());
    }

    /// @dev Invariant 2: every top-up the vault allowed came at least one cooldown after the last one to that account.
    function invariant_noAccountIsToppedUpTwiceInsideOneCooldown() public view {
        assertEq(handler.ghostTopUpsInsideCooldown(), 0);
    }

    /// @dev Invariant 3: a forward request that executed never executes again, and the signer's nonce counts each one.
    function invariant_anExecutedForwardRequestNeverExecutesAgain() public view {
        assertEq(handler.ghostReplaysAccepted(), 0);
        assertEq(forwarder.nonces(handler.metaSigner()), handler.ghostForwardedExecutions());
    }
}
