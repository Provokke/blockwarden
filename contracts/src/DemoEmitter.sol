// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";

/// @notice Emits one event per call, so a monitor rule has a real log to match, sent directly or through the forwarder.
contract DemoEmitter is ERC2771Context {
    event Ping(address indexed sender, uint256 indexed id, bytes32 tag);

    constructor(address trustedForwarder_) ERC2771Context(trustedForwarder_) {}

    function ping(uint256 id, bytes32 tag) external {
        emit Ping(_msgSender(), id, tag);
    }
}
