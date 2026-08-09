// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract DemoEmitter {
    event Ping(address indexed from, uint256 value);

    function ping(uint256 value) external {
        emit Ping(msg.sender, value);
    }
}
