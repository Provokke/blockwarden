// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TopUpVault} from "../../src/TopUpVault.sol";
import {ForwardRequests} from "../utils/ForwardRequests.sol";

/// @notice The only contract the invariant fuzzer calls. Every path that changes the vault goes through here, so the
/// ghost totals see every unit funded, credited and spent.
contract VaultHandler is CommonBase, StdUtils, ForwardRequests {
    uint256 internal constant MAX_FUND = 1e30;

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
        amount = bound(amount, 0, MAX_FUND);
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
        address account = actors[accountSeed % actors.length];
        vm.prank(actors[callerSeed % actors.length]);
        // refused inside the cooldown or on a short pool; recording only what the vault allowed is the point
        try vault.topUp(account) {
            recordTopUp(account);
        } catch {}
    }

    function forwardTopUp() external useTime {
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            metaSignerKey,
            address(vault),
            abi.encodeCall(TopUpVault.topUp, (metaSigner)),
            uint48(currentTime + 1 hours)
        );
        try forwarder.execute(request) {
            recordTopUp(metaSigner);
            ++ghostForwardedExecutions;
            lastExecuted = request;
            hasExecuted = true;
        } catch {}
    }

    function replayForwarded() external useTime {
        if (!hasExecuted) return;
        try forwarder.execute(lastExecuted) {
            ++ghostReplaysAccepted;
            recordTopUp(metaSigner);
        } catch {}
    }

    function recordTopUp(address account) internal {
        if (ghostToppedUp[account] && block.timestamp < ghostLastTopUp[account] + vault.cooldown()) {
            ++ghostTopUpsInsideCooldown;
        }
        ghostToppedUp[account] = true;
        ghostLastTopUp[account] = block.timestamp;
        ghostCredited += vault.topUpAmount();
    }
}
