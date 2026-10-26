// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {Test} from "forge-std/Test.sol";
import {FORWARDER_NAME} from "../script/DemoConfig.sol";
import {DemoEmitter} from "../src/DemoEmitter.sol";
import {ForwardRequests} from "./utils/ForwardRequests.sol";

contract DemoEmitterTest is Test, ForwardRequests {
    event Ping(address indexed sender, uint256 indexed id, bytes32 tag);

    uint256 internal constant SIGNER_KEY = 0xA11CE;

    ERC2771Forwarder internal forwarder;
    DemoEmitter internal emitter;
    address internal relayer = makeAddr("relayer");

    function setUp() public {
        forwarder = new ERC2771Forwarder(FORWARDER_NAME);
        emitter = new DemoEmitter(address(forwarder));
    }

    function test_trustsOnlyItsForwarder() public view {
        assertEq(emitter.trustedForwarder(), address(forwarder));
        assertTrue(emitter.isTrustedForwarder(address(forwarder)));
        assertFalse(emitter.isTrustedForwarder(relayer));
    }

    function test_pingIsAttributedToTheDirectCaller() public {
        address caller = makeAddr("caller");
        vm.expectEmit(address(emitter));
        emit Ping(caller, 7, bytes32("direct"));
        vm.prank(caller);
        emitter.ping(7, bytes32("direct"));
    }

    function test_pingThroughTheForwarderIsAttributedToTheSigner() public {
        ERC2771Forwarder.ForwardRequestData memory request = signRequest(
            forwarder,
            SIGNER_KEY,
            address(emitter),
            abi.encodeCall(DemoEmitter.ping, (9, bytes32("meta"))),
            uint48(block.timestamp + 1 hours)
        );
        vm.expectEmit(address(emitter));
        emit Ping(vm.addr(SIGNER_KEY), 9, bytes32("meta"));
        vm.prank(relayer);
        forwarder.execute(request);
    }

    function test_aSenderAppendedByAnyoneElseIsIgnored() public {
        // the same calldata the forwarder builds, sent by an address the emitter does not trust
        bytes memory spoofed = abi.encodePacked(abi.encodeCall(DemoEmitter.ping, (1, bytes32("x"))), makeAddr("victim"));
        vm.expectEmit(address(emitter));
        emit Ping(relayer, 1, bytes32("x"));
        vm.prank(relayer);
        (bool ok,) = address(emitter).call(spoofed);
        assertTrue(ok);
    }

    function testFuzz_pingEmitsWhatItWasGiven(address caller, uint256 id, bytes32 tag) public {
        vm.assume(caller != address(forwarder));
        vm.expectEmit(address(emitter));
        emit Ping(caller, id, tag);
        vm.prank(caller);
        emitter.ping(id, tag);
    }
}
