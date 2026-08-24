// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract Target {
    event Pinged(address indexed sender, uint256 value);

    error NotAllowed(uint256 code);

    function ping(uint256 value) external {
        emit Pinged(msg.sender, value);
    }

    function fail(uint256 code) external pure {
        revert NotAllowed(code);
    }
}
