// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReserveAttestation} from "../src/ReserveAttestation.sol";

/**
 * What the chain is told about the off-chain reserve: a band, the public
 * obligations it was measured against, and when — moving only forward in time,
 * and only from the confidential workflow.
 */
contract ReserveAttestationTest is Test {
    string constant WF = "predictsafe-reserve";
    ReserveAttestation att;
    address forwarder = address(0xF0);

    function setUp() public {
        vm.warp(1_700_000_000);
        att = new ReserveAttestation(forwarder);
        att.setExpectedAuthor(address(this));
        att.setExpectedWorkflowName(WF);
    }

    function _report(uint8 band, uint256 obligations, uint64 asOf) internal {
        bytes memory meta = abi.encodePacked(bytes32(0), att.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        att.onReport(meta, abi.encode(band, obligations, asOf, keccak256("evidence")));
    }

    function test_recordsTheBandNotABalance() public {
        assertFalse(att.covered(), "nothing attested yet");
        _report(att.AT_LEAST_150(), 308_710_000, uint64(block.timestamp - 30 minutes));
        ReserveAttestation.Attestation memory a = att.latest();
        assertEq(a.band, 2);
        assertEq(a.obligations, 308_710_000);
        assertEq(a.attestedAt, block.timestamp);
        assertEq(a.evidenceHash, keccak256("evidence"));
        assertTrue(att.covered());
        assertEq(att.count(), 1);
    }

    function test_belowOneHundredIsNotCovered() public {
        _report(att.BELOW(), 1e6, uint64(block.timestamp));
        assertFalse(att.covered());
    }

    function test_attestationsOnlyMoveForward() public {
        _report(1, 1e6, uint64(block.timestamp));
        bytes memory meta = abi.encodePacked(bytes32(0), att.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        vm.expectRevert();
        att.onReport(meta, abi.encode(uint8(1), uint256(1e6), uint64(block.timestamp - 1 hours), bytes32(0)));
    }

    function test_refusesTheFutureAndUnknownBands() public {
        bytes memory meta = abi.encodePacked(bytes32(0), att.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        vm.expectRevert();
        att.onReport(meta, abi.encode(uint8(1), uint256(1e6), uint64(block.timestamp + 1 hours), bytes32(0)));
        vm.prank(forwarder);
        vm.expectRevert();
        att.onReport(meta, abi.encode(uint8(7), uint256(1e6), uint64(block.timestamp), bytes32(0)));
    }

    function test_acceptsEveryBandUpToFiveHundred() public {
        for (uint8 b; b <= att.AT_LEAST_500(); b++) {
            _report(b, 1e6, uint64(block.timestamp) + b);
            assertEq(att.latest().band, b);
        }
        assertEq(att.count(), 7);
    }

    function test_onlyTheForwarderReports() public {
        bytes memory meta = abi.encodePacked(bytes32(0), att.getExpectedWorkflowName(), address(this));
        vm.expectRevert();
        att.onReport(meta, abi.encode(uint8(1), uint256(1e6), uint64(block.timestamp), bytes32(0)));
    }
}
