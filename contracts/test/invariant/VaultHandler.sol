// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Errors} from "@openzeppelin/contracts/utils/Errors.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TopUpVault} from "../../src/TopUpVault.sol";
import {ForwardRequests} from "../utils/ForwardRequests.sol";

/// @notice The only contract the invariant fuzzer calls. Every path that changes the vault goes through here, so the
/// ghost totals see every unit funded, credited and spent.
contract VaultHandler is CommonBase, StdUtils, ForwardRequests {
    uint256 internal constant MAX_FUND = 1e30;
    // most funding is a few top-ups' worth so the pool runs dry; one call in sixteen is large, to exercise big sums
    uint256 internal constant SMALL_FUND_TOP_UPS = 5;

    // any refusal the handler cannot justify from its own ghosts: the run fails instead of being counted as a skip
    error UnexpectedRefusal(bytes reason);

    TopUpVault public immutable vault;
    ERC2771Forwarder public immutable forwarder;
    address public immutable owner;
    uint256 internal immutable metaSignerKey;
    address public immutable metaSigner;
    address[] internal actors;

    // the clock is kept here and set at the start of every call, so the time a run has reached never depends on how
    // the fuzzer carries block state from one call to the next
    uint256 public currentTime;

    uint256 public ghostFunded;
    uint256 public ghostCredited;
    uint256 public ghostSpent;
    mapping(address account => uint256) public ghostLastTopUp;
    mapping(address account => bool) public ghostToppedUp;
    uint256 public ghostTopUpsInsideCooldown;
    uint256 public ghostForwardedExecutions;
    uint256 public ghostReplaysAccepted;

    ERC2771Forwarder.ForwardRequestData internal lastExecuted;
    bool internal hasExecuted;

    constructor(TopUpVault vault_, ERC2771Forwarder forwarder_, address owner_, uint256 start) {
        vault = vault_;
        forwarder = forwarder_;
        owner = owner_;
        currentTime = start;
        metaSignerKey = 0x5160E4;
        metaSigner = vm.addr(metaSignerKey);
        actors.push(address(0xA11CE));
        actors.push(address(0xB0B));
        actors.push(address(0xCA41));
        actors.push(metaSigner);
    }

    modifier useTime() {
        vm.warp(currentTime);
        _;
    }

    function sumOfBalances() external view returns (uint256 sum) {
        for (uint256 i; i < actors.length; ++i) {
            sum += vault.balanceOf(actors[i]);
        }
    }

    function warp(uint256 seconds_) external {
        uint256 cooldown = vault.cooldown();
        // a quarter of the steps land a second either side of a cooldown, where an off-by-one in the vault would show
        uint256 pick = seconds_ % 8;
        if (pick == 0) currentTime += cooldown - 1;
        else if (pick == 1) currentTime += cooldown;
        else currentTime += bound(seconds_, 0, 2 * cooldown);
    }

    function fund(uint256 amount) external useTime {
        // never below one top-up, so any run that reaches a top-up can credit one
        uint256 unit = vault.topUpAmount();
        amount = amount % 16 == 0 ? bound(amount, unit, MAX_FUND) : bound(amount, unit, SMALL_FUND_TOP_UPS * unit);
        vm.prank(owner);
        vault.fund(amount);
        ghostFunded += amount;
    }

    function spend(uint256 actorSeed, uint256 amount) external useTime {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 0, vault.balanceOf(actor));
        vm.prank(actor);
        vault.spend(amount);
        ghostSpent += amount;
    }

    function topUp(uint256 accountSeed, uint256 callerSeed) external useTime {
        // the meta-transaction signer is only ever credited through the forwarder, so a run's first forward request
        // is never refused for a cooldown the fuzzer opened by accident
        address account = actors[accountSeed % (actors.length - 1)];
        bool cooling = cooldownIsLive(account);
        uint256 poolBefore = vault.pool();
        vm.prank(actors[callerSeed % actors.length]);
        try vault.topUp(account) {
            recordTopUp(account, poolBefore - vault.pool());
        } catch (bytes memory reason) {
            // the only refusals the vault may give are the two the ghosts predict; anything else is a bug to surface
            bytes4 selector = bytes4(reason);
            if (selector == TopUpVault.CooldownActive.selector && cooling) return;
            if (selector == TopUpVault.PoolTooLow.selector && poolBefore < vault.topUpAmount()) return;
            revert UnexpectedRefusal(reason);
        }
    }

    function forwardTopUp() external useTime {
        // twice the cooldown, so an accepted replay could not be masked by the request having expired
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            metaSignerKey,
            address(vault),
            abi.encodeCall(TopUpVault.topUp, (metaSigner)),
            uint48(currentTime + 2 * vault.cooldown())
        );
        bool cooling = cooldownIsLive(metaSigner);
        uint256 poolBefore = vault.pool();
        try forwarder.execute(request) {
            recordTopUp(metaSigner, poolBefore - vault.pool());
            ++ghostForwardedExecutions;
            lastExecuted = request;
            hasExecuted = true;
        } catch (bytes memory reason) {
            // a fresh, correctly signed request can only fail because the vault refused the inner call
            if (bytes4(reason) == Errors.FailedCall.selector && (cooling || poolBefore < vault.topUpAmount())) return;
            revert UnexpectedRefusal(reason);
        }
    }

    function replayForwarded() external useTime {
        if (!hasExecuted) return;
        bool expired = lastExecuted.deadline < block.timestamp;
        uint256 poolBefore = vault.pool();
        try forwarder.execute(lastExecuted) {
            ++ghostReplaysAccepted;
            recordTopUp(metaSigner, poolBefore - vault.pool());
        } catch (bytes memory reason) {
            // the forwarder checks expiry before the signature, so the reason says which guard stopped the replay
            bytes4 expected = expired
                ? ERC2771Forwarder.ERC2771ForwarderExpiredRequest.selector
                : ERC2771Forwarder.ERC2771ForwarderInvalidSigner.selector;
            if (bytes4(reason) != expected) revert UnexpectedRefusal(reason);
        }
    }

    function cooldownIsLive(address account) internal view returns (bool) {
        return ghostToppedUp[account] && block.timestamp < ghostLastTopUp[account] + vault.cooldown();
    }

    // credited is what the pool actually lost, not what the vault is configured to give
    function recordTopUp(address account, uint256 applied) internal {
        if (cooldownIsLive(account)) ++ghostTopUpsInsideCooldown;
        ghostToppedUp[account] = true;
        ghostLastTopUp[account] = block.timestamp;
        ghostCredited += applied;
    }
}
