// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SportsMarket} from "../src/SportsMarket.sol";
import {AmmMarket} from "../src/AmmMarket.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * A match is three AMM markets that the DON opens and settles. What matters:
 * they open on the right terms and are tradeable exactly like any AMM market;
 * one result settles all three — Yes on what happened, No on the rest — and
 * pays a winning share one unit; a void pays half, as the AMM does; and a
 * report can only do what a person could have checked it should.
 */
contract SportsMarketTest is Test {
    string constant WF = "predictsafe-settlement";
    SportsMarket sports;
    MockUSDC usdc;
    address forwarder = address(0xF0);
    address alice = address(0xA11CE);
    uint64 constant MATCH = 537_000;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        sports = new SportsMarket(IERC20(address(usdc)), forwarder);
        sports.setExpectedAuthor(address(this));
        sports.setExpectedWorkflowName(WF);

        usdc.mint(alice, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(sports), type(uint256).max);
    }

    function _spec(uint64 id, uint64 kickoffIn) internal view returns (SportsMarket.MatchSpec memory) {
        return SportsMarket.MatchSpec({
            matchId: id,
            kickoff: uint64(block.timestamp) + kickoffIn,
            competition: "PL",
            home: "Arsenal",
            away: "Chelsea",
            liquidity: 10e6,
            openingBps: [uint16(4_500), uint16(2_700), uint16(2_800)],
            feeBps: 30
        });
    }

    function _report(SportsMarket.MatchSpec[] memory opens, SportsMarket.MatchResult[] memory results) internal {
        bytes memory meta = abi.encodePacked(bytes32(0), sports.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        sports.onReport(meta, abi.encode(opens, results));
    }

    function _open(SportsMarket.MatchSpec memory s) internal {
        SportsMarket.MatchSpec[] memory opens = new SportsMarket.MatchSpec[](1);
        opens[0] = s;
        _report(opens, new SportsMarket.MatchResult[](0));
    }

    function _result(uint64 id, uint8 result) internal {
        SportsMarket.MatchResult[] memory results = new SportsMarket.MatchResult[](1);
        results[0] = SportsMarket.MatchResult({matchId: id, result: result, evidenceHash: keccak256("score")});
        _report(new SportsMarket.MatchSpec[](0), results);
    }

    function _price(uint256 marketId) internal view returns (uint256) {
        return sports.yesPriceBps(marketId);
    }

    // --- opening ------------------------------------------------------------------

    function test_aMatchOpensAsThreeMarketsAtTheirOpeningPrices() public {
        _open(_spec(MATCH, 1 days));
        assertEq(sports.marketCount(), 3);
        assertEq(sports.matchCount(), 1);
        // Within a basis point of what was asked: the seed split floors.
        assertApproxEqAbs(_price(0), 4_500, 1);
        assertApproxEqAbs(_price(1), 2_700, 1);
        assertApproxEqAbs(_price(2), 2_800, 1);

        (SportsMarket.MatchInfo memory info, uint8 outcome) = sports.matchOf(1);
        assertEq(info.matchId, MATCH);
        assertEq(info.home, "Arsenal");
        assertEq(outcome, 2, "the middle market is the draw");
        assertEq(usdc.balanceOf(address(sports)), 30e6, "the contract minted its own seed");
    }

    function test_marketsCloseAtKickoffAndSettleTwoHoursAfter() public {
        SportsMarket.MatchSpec memory s = _spec(MATCH, 1 days);
        _open(s);
        (,,, uint64 closeTime,, uint64 settleAfter) = sports.terms(0);
        assertEq(closeTime, s.kickoff);
        assertEq(settleAfter, s.kickoff + 2 hours);
    }

    function test_tradingWorksLikeAnyAmmMarketUntilKickoff() public {
        _open(_spec(MATCH, 1 days));
        vm.prank(alice);
        uint256 shares = sports.buy(0, true, 10e6, 0);
        assertGt(shares, 10e6, "a Yes at 45 cents buys more than one share per unit");
        assertGt(_price(0), 4_500, "buying Yes moves the price up");

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        vm.expectRevert();
        sports.buy(0, true, 1e6, 0);
    }

    function test_aMatchOpensOnce() public {
        _open(_spec(MATCH, 1 days));
        _open(_spec(MATCH, 1 days));
        assertEq(sports.marketCount(), 3);
    }

    function test_openingIsBounded() public {
        _open(_spec(1, 10 minutes)); // too close to kickoff
        _open(_spec(2, 8 days)); // too far out
        SportsMarket.MatchSpec memory rich = _spec(3, 1 days);
        rich.liquidity = 101e6;
        _open(rich);
        SportsMarket.MatchSpec memory nameless = _spec(4, 1 days);
        nameless.away = "";
        _open(nameless);
        assertEq(sports.marketCount(), 0);
    }

    function test_nobodyElseOpensOrRequests() public {
        vm.expectRevert(SportsMarket.MatchesOnly.selector);
        sports.newMarket("x", AmmMarket.Asset.BTC, 1, 1, 1, 1e6, 5_000, 30);
        _open(_spec(MATCH, 1 days));
        vm.expectRevert(SportsMarket.MatchesOnly.selector);
        sports.requestSettlement(0);
    }

    // --- settling -------------------------------------------------------------------

    function test_aResultSettlesAllThree() public {
        _open(_spec(MATCH, 1 days));
        vm.warp(block.timestamp + 1 days + 2 hours);
        _result(MATCH, sports.DRAW());

        AmmMarket.PoolView memory home = sports.poolState(0);
        AmmMarket.PoolView memory draw = sports.poolState(1);
        AmmMarket.PoolView memory away = sports.poolState(2);
        assertEq(draw.outcome, uint8(AmmMarket.Outcome.Yes));
        assertEq(home.outcome, uint8(AmmMarket.Outcome.No));
        assertEq(away.outcome, uint8(AmmMarket.Outcome.No));
        assertEq(draw.status, uint8(AmmMarket.Status.Settled));
        assertEq(sports.matchAt(0).result, sports.DRAW());
    }

    function test_aWinningShareRedeemsForOneUnit() public {
        _open(_spec(MATCH, 1 days));
        vm.prank(alice);
        uint256 shares = sports.buy(0, true, 10e6, 0);
        vm.warp(block.timestamp + 1 days + 2 hours);
        _result(MATCH, sports.HOME());

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        sports.redeem(0);
        assertEq(usdc.balanceOf(alice) - before, shares);
    }

    function test_aVoidPaysHalfAUnitPerShare() public {
        _open(_spec(MATCH, 1 days));
        vm.prank(alice);
        uint256 shares = sports.buy(1, true, 10e6, 0);
        _result(MATCH, sports.VOID()); // a postponement may be reported any time
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        sports.redeem(1);
        assertEq(usdc.balanceOf(alice) - before, shares / 2);
    }

    function test_aResultBeforeTheMatchCanHaveEndedIsSkipped() public {
        _open(_spec(MATCH, 1 days));
        vm.warp(block.timestamp + 1 days + 1 hours);
        _result(MATCH, sports.HOME());
        assertEq(sports.matchAt(0).result, 0);
        assertEq(sports.poolState(0).status, uint8(AmmMarket.Status.Open));
    }

    function test_aMatchSettlesOnce_andUnknownMatchesAreSkipped() public {
        _open(_spec(MATCH, 1 days));
        vm.warp(block.timestamp + 1 days + 2 hours);
        _result(MATCH, sports.HOME());
        _result(MATCH, sports.AWAY());
        assertEq(sports.matchAt(0).result, sports.HOME(), "first result stands");
        _result(999, sports.HOME()); // nothing to settle, nothing reverts
        _result(MATCH, 9);
    }

    function test_unsettledListsWhatStillNeedsAResult() public {
        _open(_spec(1, 1 days));
        _open(_spec(2, 2 days));
        vm.warp(block.timestamp + 1 days + 2 hours);
        _result(1, sports.AWAY());
        (uint64[] memory ids, uint64[] memory kickoffs) = sports.unsettled(10);
        assertEq(ids.length, 1);
        assertEq(ids[0], 2);
        assertGt(kickoffs[0], 0);
    }

    function test_reportIsBounded_andOnlyFromTheForwarder() public {
        SportsMarket.MatchSpec[] memory opens = new SportsMarket.MatchSpec[](7);
        for (uint64 i; i < 7; i++) opens[i] = _spec(i + 1, 1 days);
        bytes memory meta = abi.encodePacked(bytes32(0), sports.getExpectedWorkflowName(), address(this));
        vm.prank(forwarder);
        vm.expectRevert(SportsMarket.TooManyInReport.selector);
        sports.onReport(meta, abi.encode(opens, new SportsMarket.MatchResult[](0)));

        vm.expectRevert();
        sports.onReport(meta, abi.encode(new SportsMarket.MatchSpec[](0), new SportsMarket.MatchResult[](0)));
    }
}
