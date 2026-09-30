// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ERC2771Forwarder} from "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";
import {CommonBase} from "forge-std/Base.sol";
import {FORWARDER_NAME} from "../../script/DemoConfig.sol";

/// @notice Signs forward requests the way a wallet does, from the domain written out here rather than the one the
/// forwarder reports, so a forwarder deployed under the wrong name fails these tests instead of agreeing with them.
abstract contract ForwardRequests is CommonBase {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant FORWARD_REQUEST_TYPEHASH = keccak256(
        "ForwardRequest(address from,address to,uint256 value,uint256 gas,uint256 nonce,uint48 deadline,bytes data)"
    );

    // enough for any call the tests forward; the forwarder refuses to run a call on less than it was promised
    uint256 internal constant FORWARDED_GAS = 100_000;

    function signRequest(ERC2771Forwarder forwarder, uint256 signerKey, address to, bytes memory data, uint48 deadline)
        internal
        view
        returns (ERC2771Forwarder.ForwardRequestData memory request)
    {
        request = ERC2771Forwarder.ForwardRequestData({
            from: vm.addr(signerKey),
            to: to,
            value: 0,
            gas: FORWARDED_GAS,
            deadline: deadline,
            data: data,
            signature: ""
        });
        request.signature = signature(forwarder, signerKey, request);
    }

    function signature(
        ERC2771Forwarder forwarder,
        uint256 signerKey,
        ERC2771Forwarder.ForwardRequestData memory request
    ) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest(forwarder, request, forwarder.nonces(request.from)));
        return abi.encodePacked(r, s, v);
    }

    function digest(ERC2771Forwarder forwarder, ERC2771Forwarder.ForwardRequestData memory request, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes(FORWARDER_NAME)), keccak256("1"), block.chainid, address(forwarder)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                FORWARD_REQUEST_TYPEHASH,
                request.from,
                request.to,
                request.value,
                request.gas,
                nonce,
                request.deadline,
                keccak256(request.data)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
