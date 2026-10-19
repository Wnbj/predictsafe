// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketScheduler, ICryptoMarketCreate} from "../src/MarketScheduler.sol";
import {CryptoMarket} from "../src/CryptoMarket.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ReceiverTemplate} from "../src/interfaces/ReceiverTemplate.sol";

/**
 * The scheduler opens what the DON names — once per slot, and only terms a
 * person could stake on. A spec it will not open is skipped with a reason; the
 * rest of the batch still opens.
 */
contract MarketSchedulerTest is Test {
    string constant WF = "predictsafe-settlement";

    CryptoMarket crypto;
    MarketScheduler scheduler;
    address forwarder = address(0xF0);

    function setUp() public {
        vm.warp(1_700_000_000);
        crypto = new CryptoMarket(IERC20(address(new MockUSDC())), address(0xBEEF));
        scheduler = new MarketScheduler(forwarder, ICryptoMarketCreate(address(crypto)));
        scheduler.setExpectedAuthor(address(this));
        scheduler.setExpectedWorkflowName(WF);
    }

    function _spec(uint8 asset, uint64 strike, uint64 closeIn, uint64 expiryIn)
        internal
        view
        returns (MarketScheduler.Spec memory)
    {
        return MarketScheduler.Spec({
            asset: asset,
            strike: strike,
            closeTime: uint64(block.timestamp) + closeIn,
            expiryTime: uint64(block.timestamp) + expiryIn,
            question: "Will BTC be at or above $83,300 at 12:00 UTC on Oct 19?"
        });
    }

    function _report(MarketScheduler.Spec[] memory specs) internal {
        bytes memory meta = abi.encodePacked(bytes32(0), scheduler.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        scheduler.onReport(meta, abi.encode(specs));
    }

    function _one(MarketScheduler.Spec memory s) internal pure returns (MarketScheduler.Spec[] memory a) {
        a = new MarketScheduler.Spec[](1);
        a[0] = s;
    }

    function test_opensTheNamedMarket() public {
        MarketScheduler.Spec memory s = _spec(0, 83_300e8, 45 minutes, 1 hours);
        _report(_one(s));

        assertEq(crypto.marketCount(), 1);
        (string memory q, uint64 closeTime, uint64 settleAfter,,,,,,) = crypto.core(0);
        assertEq(q, s.question);
        assertEq(closeTime, s.closeTime);
        assertEq(settleAfter, s.expiryTime + crypto.SETTLEMENT_DELAY());
        (CryptoMarket.Asset asset, uint64 strike, uint64 expiry) = crypto.terms(0);
        assertEq(uint8(asset), 0);
        assertEq(strike, 83_300e8);
        assertEq(expiry, s.expiryTime);

        (bool exists, uint256 id) = scheduler.scheduled(0, s.closeTime, s.expiryTime);
        assertTrue(exists);
        assertEq(id, 0);
    }

    function test_aSlotOpensOnce() public {
        MarketScheduler.Spec memory s = _spec(0, 83_300e8, 45 minutes, 1 hours);
        _report(_one(s));
        _report(_one(s)); // the next run, still reading the finalized block
        assertEq(crypto.marketCount(), 1, "a repeat is a skip, not a second market");
    }

    function test_hourlyAndDailyWithTheSameExpiryAreDifferentSlots() public {
        MarketScheduler.Spec[] memory both = new MarketScheduler.Spec[](2);
        both[0] = _spec(0, 83_300e8, 45 minutes, 1 hours);
        both[1] = _spec(0, 83_300e8, 20 minutes, 1 hours);
        _report(both);
        assertEq(crypto.marketCount(), 2);
    }

    function test_badSpecsAreSkippedAndTheRestStillOpen() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](6);
        specs[0] = _spec(0, 83_300e8, 2 minutes, 1 hours); // too late to stake
        specs[1] = _spec(0, 0, 45 minutes, 1 hours); // no strike
        specs[2] = _spec(0, 83_300e8, 2 hours, 1 hours); // closes after expiry
        specs[3] = _spec(0, 83_300e8, 45 minutes, 4 days); // too far out
        specs[4] = _spec(7, 83_300e8, 45 minutes, 1 hours); // unknown asset
        specs[5] = _spec(1, 3_000e8, 30 minutes, 4 hours); // fine: ETH
        _report(specs);
        assertEq(crypto.marketCount(), 1);
        (CryptoMarket.Asset asset,,) = crypto.terms(0);
        assertEq(uint8(asset), 1);
    }

    function test_aQuestionMustBeSensible() public {
        MarketScheduler.Spec memory s = _spec(0, 83_300e8, 45 minutes, 1 hours);
        s.question = "";
        _report(_one(s));
        assertEq(crypto.marketCount(), 0);
    }

    function test_batchIsBounded() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](7);
        for (uint256 i; i < 7; i++) specs[i] = _spec(0, uint64(80_000e8 + i * 100e8), 45 minutes, 1 hours);
        bytes memory meta = abi.encodePacked(bytes32(0), scheduler.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        vm.expectRevert(MarketScheduler.TooManySpecs.selector);
        scheduler.onReport(meta, abi.encode(specs));
    }

    function test_onlyTheForwarderReports() public {
        bytes memory meta = abi.encodePacked(bytes32(0), scheduler.getExpectedWorkflowName(), address(this));
        vm.expectRevert();
        scheduler.onReport(meta, abi.encode(_one(_spec(0, 83_300e8, 45 minutes, 1 hours))));
    }
}
