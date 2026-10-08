// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SettlementKeeper} from "../src/SettlementKeeper.sol";
import {CryptoMarket} from "../src/CryptoMarket.sol";
import {FlightMarket} from "../src/FlightMarket.sol";
import {AmmMarket} from "../src/AmmMarket.sol";
import {ParimutuelMarket} from "../src/ParimutuelMarket.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ReceiverTemplate} from "../src/interfaces/ReceiverTemplate.sol";

/**
 * The keeper against the real market contracts, not mocks of them: the whole
 * point is that it reads three different getter shapes correctly, and a mock
 * would only prove it reads the mock.
 */
contract SettlementKeeperTest is Test {
    string constant WF = "predictsafe-settlement";
    uint32 constant FLIGHT_DELAY = 6 hours;

    MockUSDC token;
    CryptoMarket crypto;
    FlightMarket flights;
    AmmMarket amm;
    SettlementKeeper keeper;
    address forwarder = address(0xF0);

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockUSDC();
        crypto = new CryptoMarket(IERC20(address(token)), address(0xBEEF));
        flights = new FlightMarket(IERC20(address(token)), address(0xBEEF));
        amm = new AmmMarket(IERC20(address(token)), address(0xBEEF));

        keeper = new SettlementKeeper(forwarder);
        keeper.setExpectedAuthor(address(this));
        keeper.setExpectedWorkflowName(WF);
        keeper.watch(address(crypto), SettlementKeeper.Kind.Parimutuel, 0);
        keeper.watch(address(flights), SettlementKeeper.Kind.Flight, FLIGHT_DELAY);
        keeper.watch(address(amm), SettlementKeeper.Kind.Amm, 0);

        token.mint(address(this), 1_000e6);
        token.approve(address(amm), type(uint256).max);
    }

    // --- helpers -------------------------------------------------------------

    /// Crypto market expiring in `secs`; settleAfter is expiry + 60s.
    function _crypto(uint256 secs) internal returns (uint256) {
        uint64 t = uint64(block.timestamp + secs);
        return crypto.newMarket("BTC?", CryptoMarket.Asset.BTC, 60_000e8, t, t);
    }

    function _flight(uint256 settleIn) internal returns (uint256) {
        uint64 s = uint64(block.timestamp + settleIn);
        return flights.newMarket("BA286 late?", "BA286", 20261008, 45, s - 1, s);
    }

    function _amm(uint256 secs) internal returns (uint256) {
        uint64 t = uint64(block.timestamp + secs);
        return amm.newMarket("BTC?", AmmMarket.Asset.BTC, 60_000e8, t, t, 10e6, 5_000, 30);
    }

    function _meta() internal view returns (bytes memory) {
        return abi.encodePacked(bytes32(0), keeper.getExpectedWorkflowName(), address(this));
    }

    function _report(address[] memory m, uint256[] memory ids) internal {
        bytes memory meta = _meta(); // an external read — must not eat the prank
        vm.prank(forwarder);
        keeper.onReport(meta, abi.encode(m, ids));
    }

    function _one(address m, uint256 id) internal pure returns (address[] memory ms, uint256[] memory ids) {
        ms = new address[](1);
        ids = new uint256[](1);
        ms[0] = m;
        ids[0] = id;
    }

    function _cryptoStatus(uint256 id) internal view returns (uint8) {
        (, , , ParimutuelMarket.Status status, , , , , ) = crypto.core(id);
        return uint8(status);
    }

    function _flightStatus(uint256 id) internal view returns (uint8) {
        (, , , , , , FlightMarket.Status status, , , , , ) = flights.markets(id);
        return uint8(status);
    }

    // --- what is due ---------------------------------------------------------

    function test_nothingIsDueBeforeSettleAfter() public {
        _crypto(5 minutes);
        _amm(5 minutes);
        (address[] memory m,) = keeper.dueMarkets(10);
        assertEq(m.length, 0);
    }

    function test_cryptoAndAmmAreDueTheMomentSettleAfterPasses() public {
        uint256 c = _crypto(5 minutes);
        uint256 a = _amm(5 minutes);
        vm.warp(block.timestamp + 5 minutes + 60);

        assertTrue(keeper.isDue(address(crypto), c));
        assertTrue(keeper.isDue(address(amm), a));
        (address[] memory m, uint256[] memory ids) = keeper.dueMarkets(10);
        assertEq(m.length, 2);
        assertEq(m[0], address(crypto));
        assertEq(ids[0], c);
        assertEq(m[1], address(amm));
        assertEq(ids[1], a);
    }

    /// The reason the keeper has a delay at all: a flight still airborne at
    /// settlement voids, so it must not be asked the minute it could be.
    function test_flightsWaitSixHoursPastSettleAfter() public {
        uint256 f = _flight(1 hours);
        vm.warp(block.timestamp + 1 hours);
        assertFalse(keeper.isDue(address(flights), f), "a person could press now; the keeper must not");

        vm.warp(block.timestamp + FLIGHT_DELAY - 1);
        assertFalse(keeper.isDue(address(flights), f));

        vm.warp(block.timestamp + 1);
        assertTrue(keeper.isDue(address(flights), f));
    }

    function test_dueMarketsStopsAtMax() public {
        for (uint256 i; i < 5; i++) _crypto(1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        (address[] memory m, uint256[] memory ids) = keeper.dueMarkets(3);
        assertEq(m.length, 3);
        assertEq(ids[0], 4, "newest first");
    }

    function test_onlyTheNewestScanBackMarketsAreExamined() public {
        uint256 oldest = _crypto(1 minutes);
        for (uint256 i; i < keeper.SCAN_BACK(); i++) crypto.newMarket("x", CryptoMarket.Asset.BTC, 1, uint64(block.timestamp + 30 days), uint64(block.timestamp + 30 days));
        vm.warp(block.timestamp + 2 minutes);

        assertTrue(keeper.isDue(address(crypto), oldest), "isDue itself has no window");
        (address[] memory m,) = keeper.dueMarkets(10);
        assertEq(m.length, 0, "but the scan does");
    }

    function test_aRequestedMarketIsNoLongerDue() public {
        uint256 c = _crypto(1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        crypto.requestSettlement(c); // a person got there first
        assertFalse(keeper.isDue(address(crypto), c));
    }

    function test_anUnwatchedContractIsNeverDue() public {
        uint256 c = _crypto(1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        keeper.unwatch(address(crypto));
        assertFalse(keeper.isDue(address(crypto), c));
        (address[] memory m,) = keeper.dueMarkets(10);
        assertEq(m.length, 0);
        assertEq(keeper.watchedCount(), 2);
    }

    // --- the report ----------------------------------------------------------

    function test_reportRequestsSettlementOnEveryKind() public {
        uint256 c = _crypto(1 minutes);
        uint256 a = _amm(1 minutes);
        uint256 f = _flight(1 minutes);
        vm.warp(block.timestamp + 2 minutes + FLIGHT_DELAY);

        (address[] memory m, uint256[] memory ids) = keeper.dueMarkets(10);
        assertEq(m.length, 3);
        _report(m, ids);

        assertEq(_cryptoStatus(c), uint8(ParimutuelMarket.Status.SettlementRequested));
        assertEq(_flightStatus(f), uint8(FlightMarket.Status.SettlementRequested));
        assertEq(amm.poolState(a).status, uint8(AmmMarket.Status.SettlementRequested));
    }

    /// The event the workflow's log trigger listens for comes from the MARKET,
    /// exactly as when a person presses the button — the keeper is just the
    /// caller, and nothing downstream can tell the difference.
    function test_theMarketEmitsItsOwnSettlementRequestedEvent() public {
        uint256 c = _crypto(1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        (address[] memory m, uint256[] memory ids) = _one(address(crypto), c);

        vm.recordLogs();
        _report(m, ids);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool fromMarket;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == address(crypto) && logs[i].topics[0] == CryptoMarket.SettlementRequested.selector) {
                fromMarket = true;
            }
        }
        assertTrue(fromMarket);
    }

    /// Reads are pinned to the finalized block, so the next run can name a
    /// market this one already requested. That must skip, not revert.
    function test_aStaleIdIsSkippedAndTheRestStillGoThrough() public {
        uint256 done = _crypto(1 minutes);
        uint256 fresh = _crypto(1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        crypto.requestSettlement(done);

        address[] memory m = new address[](2);
        uint256[] memory ids = new uint256[](2);
        (m[0], ids[0]) = (address(crypto), done);
        (m[1], ids[1]) = (address(crypto), fresh);

        vm.expectEmit(true, true, false, true, address(keeper));
        emit SettlementKeeper.SettlementRequestSkipped(address(crypto), done, "not due");
        _report(m, ids);
        assertEq(_cryptoStatus(fresh), uint8(ParimutuelMarket.Status.SettlementRequested));
    }

    /// The delay is enforced HERE, so a report cannot get around it.
    function test_aReportCannotRequestAFlightEarly() public {
        uint256 f = _flight(1 minutes);
        vm.warp(block.timestamp + 2 minutes); // past settleAfter, inside the delay
        (address[] memory m, uint256[] memory ids) = _one(address(flights), f);
        _report(m, ids);
        assertEq(_flightStatus(f), uint8(FlightMarket.Status.Open));
    }

    function test_aReportCannotTouchAnUnwatchedContract() public {
        CryptoMarket other = new CryptoMarket(IERC20(address(token)), address(0xBEEF));
        uint64 t = uint64(block.timestamp + 1 minutes);
        uint256 id = other.newMarket("x", CryptoMarket.Asset.BTC, 1, t, t);
        vm.warp(block.timestamp + 2 minutes);
        (address[] memory m, uint256[] memory ids) = _one(address(other), id);
        _report(m, ids);
        (, , , ParimutuelMarket.Status status, , , , , ) = other.core(id);
        assertEq(uint8(status), uint8(ParimutuelMarket.Status.Open));
    }

    function test_mismatchedArraysRevert() public {
        address[] memory m = new address[](2);
        uint256[] memory ids = new uint256[](1);
        bytes memory meta = _meta();
        vm.prank(forwarder);
        vm.expectRevert(SettlementKeeper.LengthMismatch.selector);
        keeper.onReport(meta, abi.encode(m, ids));
    }

    // --- who may do what -----------------------------------------------------

    function test_onlyTheForwarderDeliversReports() public {
        (address[] memory m, uint256[] memory ids) = _one(address(crypto), 0);
        bytes memory meta = _meta();
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder));
        keeper.onReport(meta, abi.encode(m, ids));
    }

    function test_onlyTheOwnerConfigures() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        keeper.watch(address(0x1), SettlementKeeper.Kind.Parimutuel, 0);
    }

    function test_watchingAgainUpdatesInPlace() public {
        keeper.watch(address(flights), SettlementKeeper.Kind.Flight, 1 hours);
        assertEq(keeper.watchedCount(), 3);
        (address market,, uint32 delay) = keeper.watchedAt(1);
        assertEq(market, address(flights));
        assertEq(delay, 1 hours);
    }
}
