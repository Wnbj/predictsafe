// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MarketScheduler} from "../src/MarketScheduler.sol";
import {CryptoMarket} from "../src/CryptoMarket.sol";
import {StockMarket} from "../src/StockMarket.sol";
import {ReserveMarket} from "../src/ReserveMarket.sol";
import {FlightMarket} from "../src/FlightMarket.sol";
import {AmmMarket} from "../src/AmmMarket.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * The scheduler opens what the DON names — on the right contract, once per
 * slot, and only terms a person could stake on. A spec it will not open is
 * skipped with a reason; the rest of the batch still opens.
 */
contract MarketSchedulerTest is Test {
    string constant WF = "predictsafe-settlement";
    uint8 constant CRYPTO = 0;
    uint8 constant STOCK = 1;
    uint8 constant RESERVE = 2;
    uint8 constant FLIGHT = 3;
    uint8 constant AMM = 4;

    MockUSDC usdc;
    CryptoMarket crypto;
    StockMarket stock;
    ReserveMarket reserve;
    FlightMarket flights;
    AmmMarket amm;
    MarketScheduler scheduler;
    address forwarder = address(0xF0);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        IERC20 t = IERC20(address(usdc));
        crypto = new CryptoMarket(t, address(0xBEEF));
        stock = new StockMarket(t, address(0xBEEF));
        reserve = new ReserveMarket(t, address(0xBEEF));
        flights = new FlightMarket(t, address(0xBEEF));
        amm = new AmmMarket(t, address(0xBEEF));
        stock.registerFeed("XAU", address(0xFEED1));
        reserve.registerFeed("USTB", address(0xFEED2));

        scheduler = new MarketScheduler(
            forwarder,
            MarketScheduler.Targets({
                crypto: address(crypto),
                stock: address(stock),
                reserve: address(reserve),
                flight: address(flights),
                amm: address(amm),
                usdc: address(usdc)
            })
        );
        scheduler.setExpectedAuthor(address(this));
        scheduler.setExpectedWorkflowName(WF);
    }

    // --- helpers ------------------------------------------------------------

    function _spec(uint8 kind, string memory id, uint64 closeIn, uint64 expiryIn, bytes memory terms)
        internal
        view
        returns (MarketScheduler.Spec memory)
    {
        return MarketScheduler.Spec({
            kind: kind,
            closeTime: uint64(block.timestamp) + closeIn,
            expiryTime: uint64(block.timestamp) + expiryIn,
            id: id,
            question: "Will it be at or above the strike?",
            terms: terms
        });
    }

    function _btc(uint64 closeIn, uint64 expiryIn) internal view returns (MarketScheduler.Spec memory) {
        return _spec(CRYPTO, "BTC", closeIn, expiryIn, abi.encode(uint8(0), uint64(83_300e8)));
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

    function _key(MarketScheduler.Spec memory s) internal view returns (bytes32) {
        return scheduler.slotKey(s.kind, s.closeTime, s.expiryTime, s.id);
    }

    // --- each kind lands on its own contract ----------------------------------

    function test_cryptoOpensOnCryptoMarket() public {
        MarketScheduler.Spec memory s = _btc(45 minutes, 1 hours);
        _report(_one(s));
        assertEq(crypto.marketCount(), 1);
        (CryptoMarket.Asset asset, uint64 strike, uint64 expiry) = crypto.terms(0);
        assertEq(uint8(asset), 0);
        assertEq(strike, 83_300e8);
        assertEq(expiry, s.expiryTime);
        (bool exists, uint256 id) = scheduler.scheduled(_key(s));
        assertTrue(exists);
        assertEq(id, 0);
    }

    function test_stockOpensOnStockMarketWithTheSymbolAsId() public {
        _report(_one(_spec(STOCK, "XAU", 3 hours, 4 hours, abi.encode(uint64(4_120e8), uint32(3 hours)))));
        assertEq(stock.marketCount(), 1);
        (address feed, uint64 strike,, uint32 maxStaleness) = stock.terms(0);
        assertEq(feed, address(0xFEED1));
        assertEq(strike, 4_120e8);
        assertEq(maxStaleness, 3 hours);
    }

    function test_reserveOpensOnReserveMarket() public {
        _report(_one(_spec(RESERVE, "USTB", 20 hours, 1 days, abi.encode(uint64(11.25e8), uint32(2 days)))));
        assertEq(reserve.marketCount(), 1);
        assertEq(crypto.marketCount() + stock.marketCount(), 0);
    }

    function test_flightOpensWithExpiryAsSettleAfter() public {
        MarketScheduler.Spec memory s = _spec(FLIGHT, "BA286", 6 hours, 2 days, abi.encode(uint32(20261021), uint16(45)));
        _report(_one(s));
        assertEq(flights.marketCount(), 1);
        (, string memory iata, uint32 date, uint16 threshold, uint64 closeTime, uint64 settleAfter,,,,,,) =
            flights.markets(0);
        assertEq(iata, "BA286");
        assertEq(date, 20261021);
        assertEq(threshold, 45);
        assertEq(closeTime, s.closeTime);
        assertEq(settleAfter, s.expiryTime);
    }

    function test_ammIsSeededWithLiquidityTheSchedulerMints() public {
        bytes memory terms = abi.encode(uint8(0), uint64(83_300e8), uint256(20e6), uint256(5_000), uint16(30));
        _report(_one(_spec(AMM, "BTC", 20 hours, 1 days, terms)));
        assertEq(amm.marketCount(), 1);
        assertEq(usdc.balanceOf(address(amm)), 20e6, "the pool holds the seed");
        assertEq(amm.poolState(0).creator, address(scheduler));
    }

    // --- bounds -----------------------------------------------------------------

    function test_aSlotOpensOnce() public {
        MarketScheduler.Spec memory s = _btc(45 minutes, 1 hours);
        _report(_one(s));
        _report(_one(s)); // the next run, still reading the finalized block
        assertEq(crypto.marketCount(), 1);
    }

    function test_sameTimesDifferentKindsOrIdsAreDifferentSlots() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](3);
        specs[0] = _btc(45 minutes, 1 hours);
        specs[1] = _spec(CRYPTO, "ETH", 45 minutes, 1 hours, abi.encode(uint8(1), uint64(2_400e8)));
        specs[2] = _spec(AMM, "BTC", 45 minutes, 1 hours, abi.encode(uint8(0), uint64(83_300e8), uint256(10e6), uint256(5_000), uint16(30)));
        _report(specs);
        assertEq(crypto.marketCount(), 2);
        assertEq(amm.marketCount(), 1);
    }

    function test_badSpecsAreSkippedAndTheRestStillOpen() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](6);
        specs[0] = _btc(2 minutes, 1 hours); // too late to stake
        specs[1] = _btc(2 hours, 1 hours); // closes after expiry
        specs[2] = _btc(45 minutes, 5 days); // too far out
        specs[3] = _spec(9, "BTC", 45 minutes, 1 hours, ""); // unknown kind
        specs[4] = _spec(STOCK, "NOPE", 3 hours, 4 hours, abi.encode(uint64(1e8), uint32(1 hours))); // refused: no feed
        specs[5] = _spec(CRYPTO, "ETH", 30 minutes, 4 hours, abi.encode(uint8(1), uint64(2_400e8))); // fine
        _report(specs);
        assertEq(crypto.marketCount(), 1);
        assertEq(stock.marketCount(), 0);
    }

    function test_termsThatDoNotDecodeAreSkippedNotReverted() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](2);
        specs[0] = _spec(FLIGHT, "BA286", 6 hours, 2 days, hex"01");
        specs[1] = _btc(45 minutes, 1 hours);
        _report(specs);
        assertEq(flights.marketCount(), 0);
        assertEq(crypto.marketCount(), 1);
    }

    function test_ammLiquidityIsBounded() public {
        bytes memory terms = abi.encode(uint8(0), uint64(83_300e8), uint256(101e6), uint256(5_000), uint16(30));
        _report(_one(_spec(AMM, "BTC", 20 hours, 1 days, terms)));
        assertEq(amm.marketCount(), 0);
    }

    function test_aQuestionAndIdMustBeSensible() public {
        MarketScheduler.Spec memory s = _btc(45 minutes, 1 hours);
        s.question = "";
        _report(_one(s));
        s = _btc(45 minutes, 1 hours);
        s.id = "";
        _report(_one(s));
        assertEq(crypto.marketCount(), 0);
    }

    function test_batchIsBounded() public {
        MarketScheduler.Spec[] memory specs = new MarketScheduler.Spec[](7);
        for (uint256 i; i < 7; i++) specs[i] = _btc(uint64(45 minutes + i), 1 hours);
        bytes memory meta = abi.encodePacked(bytes32(0), scheduler.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        vm.expectRevert(MarketScheduler.TooManySpecs.selector);
        scheduler.onReport(meta, abi.encode(specs));
    }

    function test_onlyTheForwarderReports() public {
        bytes memory meta = abi.encodePacked(bytes32(0), scheduler.getExpectedWorkflowName(), address(this));
        vm.expectRevert();
        scheduler.onReport(meta, abi.encode(_one(_btc(45 minutes, 1 hours))));
    }

    function test_openOneIsNotACallableBackDoor() public {
        vm.expectRevert(MarketScheduler.OnlySelf.selector);
        scheduler.openOne(_btc(45 minutes, 1 hours));
    }

    // --- migration ----------------------------------------------------------------

    function test_adoptedSlotsAreNotOpenedAgain() public {
        MarketScheduler.Spec memory s = _btc(45 minutes, 1 hours);
        bytes32[] memory keys = new bytes32[](1);
        uint256[] memory ids = new uint256[](1);
        keys[0] = _key(s);
        ids[0] = 19;
        scheduler.adopt(keys, ids);
        _report(_one(s));
        assertEq(crypto.marketCount(), 0);
        (, uint256 id) = scheduler.scheduled(keys[0]);
        assertEq(id, 19);
    }

    function test_adoptIsOwnerOnly() public {
        vm.prank(address(0xA11CE));
        vm.expectRevert();
        scheduler.adopt(new bytes32[](0), new uint256[](0));
    }

    function test_scheduledManyAnswersEachKey() public {
        MarketScheduler.Spec memory s = _btc(45 minutes, 1 hours);
        _report(_one(s));
        bytes32[] memory keys = new bytes32[](2);
        keys[0] = _key(s);
        keys[1] = keccak256("nothing");
        bool[] memory open = scheduler.scheduledMany(keys);
        assertTrue(open[0]);
        assertFalse(open[1]);
    }
}
