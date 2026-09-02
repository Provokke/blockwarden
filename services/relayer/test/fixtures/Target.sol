// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

contract Target {
    event Pinged(address indexed sender, uint256 value);

    event Fired(address indexed sender);

    error NotAllowed(uint256 code);
    error NotArmed();

    mapping(address => bool) public armed;

    function ping(uint256 value) external {
        emit Pinged(msg.sender, value);
    }

    function fail(uint256 code) external pure {
        revert NotAllowed(code);
    }

    // stands in for an approval: fire reverts until arm has been mined
    function arm() external {
        armed[msg.sender] = true;
    }

    function fire() external {
        if (!armed[msg.sender]) revert NotArmed();
        emit Fired(msg.sender);
    }
}
