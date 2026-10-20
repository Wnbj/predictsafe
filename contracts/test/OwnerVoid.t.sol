// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AmmMarket} from "../src/AmmMarket.sol";
import {SportsMarket} from "../src/SportsMarket.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {OwnerVoid} from "../script/OwnerVoid.s.sol";

/**
 * The escape hatch for markets with no `ownerVoid`: the owner voids through
 * the report path and hands the forwarder role back. What has to hold — the
 * market ends Void and pays half a unit a share, the forwarder is the DON's
 * again afterwards, and nobody but the owner can do it.
 */
contract OwnerVoidTest is Test {
    string constant WF = "predictsafe-settlement";
    address constant DON_FORWARDER = address(0xF0);
    address constant AUTHOR = address(0xA0);
    address alice = address(0xA11CE);

    MockUSDC usdc;
    AmmMarket amm;
    SportsMarket sports;
    OwnerVoid hatch;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        amm = new AmmMarket(IERC20(address(usdc)), DON_FORWARDER);
        sports = new SportsMarket(IERC20(address(usdc)), DON_FORWARDER);
        amm.setExpectedAuthor(AUTHOR);
        amm.setExpectedWorkflowName(WF);
        sports.setExpectedAuthor(AUTHOR);
        sports.setExpectedWorkflowName(WF);
        hatch = new OwnerVoid();

        usdc.mint(alice, 1_000e6);
        vm.startPrank(alice);
        usdc.approve(address(amm), type(uint256).max);
        usdc.approve(address(sports), type(uint256).max);
        vm.stopPrank();
    }

    function test_voidsAnAmmMarketTheDonNeverSettled() public {
        usdc.mint(address(this), 20e6);
        usdc.approve(address(amm), 20e6);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 id = amm.newMarket("q", AmmMarket.Asset.BTC, 1, expiry - 10 minutes, expiry, 20e6, 5_000, 30);
        vm.prank(alice);
        uint256 shares = amm.buy(id, true, 10e6, 0);

        // Past settleAfter and nobody ever asked: the script asks, then voids.
        vm.warp(expiry + 2 hours);
        amm.transferOwnership(address(hatch));
        hatch.voidAmmMarket(amm, id, address(hatch));

        assertEq(amm.poolState(id).status, uint8(AmmMarket.Status.Void));
        assertEq(amm.getForwarderAddress(), DON_FORWARDER, "the DON's role is handed back");

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        amm.redeem(id);
        assertEq(usdc.balanceOf(alice) - before, shares / 2, "a void pays half a unit a share");
    }

    function test_voidsAllThreeMarketsOfAMatch() public {
        SportsMarket.MatchSpec[] memory opens = new SportsMarket.MatchSpec[](1);
        opens[0] = SportsMarket.MatchSpec({
            matchId: 42,
            kickoff: uint64(block.timestamp + 2 hours),
            competition: "PL",
            home: "Arsenal",
            away: "Chelsea",
            liquidity: 10e6,
            openingBps: [uint16(4_500), uint16(2_700), uint16(2_800)],
            feeBps: 30
        });
        bytes memory meta = abi.encodePacked(bytes32(0), sports.getExpectedWorkflowName(), AUTHOR);
        vm.prank(DON_FORWARDER);
        sports.onReport(meta, abi.encode(opens, new SportsMarket.MatchResult[](0)));

        sports.transferOwnership(address(hatch));
        hatch.voidMatch(sports, 42, address(hatch));

        for (uint256 i; i < 3; i++) assertEq(sports.poolState(i).status, uint8(AmmMarket.Status.Void));
        assertEq(sports.getForwarderAddress(), DON_FORWARDER);
    }

    function test_nobodyButTheOwner() public {
        usdc.mint(address(this), 20e6);
        usdc.approve(address(amm), 20e6);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        uint256 id = amm.newMarket("q", AmmMarket.Asset.BTC, 1, expiry - 10 minutes, expiry, 20e6, 5_000, 30);
        vm.warp(expiry + 2 hours);
        // The hatch is not the owner here.
        vm.expectRevert();
        hatch.voidAmmMarket(amm, id, address(hatch));
    }
}
