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

        // a pool that starts able to pay, so a run that opens with top-ups is not spent refusing them
        for (uint256 i; i < 4; ++i) {
            handler.fund(1);
        }

        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = VaultHandler.warp.selector;
        selectors[1] = VaultHandler.fund.selector;
        selectors[2] = VaultHandler.spend.selector;
        selectors[3] = VaultHandler.topUp.selector;
        selectors[4] = VaultHandler.forwardTopUp.selector;
        selectors[5] = VaultHandler.replayForwarded.selector;
        // listed three times: a run of 64 calls that never sends a forward request would test nothing about them
        selectors[6] = VaultHandler.forwardTopUp.selector;
        selectors[7] = VaultHandler.forwardTopUp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @dev A run in which nothing was credited or forwarded would pass every invariant while testing nothing.
    function afterInvariant() public view {
        assertGt(handler.ghostCredited(), 0, "no top-up was ever credited");
        assertGt(handler.ghostForwardedExecutions(), 0, "no forward request ever executed");
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
