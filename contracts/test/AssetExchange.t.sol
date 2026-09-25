// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AssetExchange, SyntheticAsset, IPriceFeed} from "../src/AssetExchange.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// A feed whose rounds the test publishes by hand, numbered the way a real
/// aggregator proxy numbers them: phase in the top 16 bits, round below.
contract MockFeed is IPriceFeed {
    struct R { int256 answer; uint256 updatedAt; }

    uint8 public immutable override decimals;
    uint80 public phase = 1;
    uint64 public count;
    mapping(uint80 => R) internal rounds;

    constructor(uint8 d) { decimals = d; }

    function id(uint64 n) public view returns (uint80) { return (phase << 64) | n; }

    function push(int256 answer) external returns (uint80 roundId) {
        count++;
        roundId = id(count);
        rounds[roundId] = R(answer, block.timestamp);
    }

    /// A new aggregator behind the proxy: numbering restarts.
    function newPhase(int256 answer) external {
        phase++;
        count = 1;
        rounds[id(1)] = R(answer, block.timestamp);
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        uint80 r = id(count);
        return (r, rounds[r].answer, rounds[r].updatedAt, rounds[r].updatedAt, r);
    }

    function getRoundData(uint80 r) external view override returns (uint80, int256, uint256, uint256, uint80) {
        require(rounds[r].updatedAt != 0, "No data present");
        return (r, rounds[r].answer, rounds[r].updatedAt, rounds[r].updatedAt, r);
    }
}

contract AssetExchangeTest is Test {
    AssetExchange internal ex;
    MockUSDC internal usdc;
    MockFeed internal gold;
    SyntheticAsset internal sXAU;

    address internal forwarder = address(0xF0);
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    string internal constant WF = "predictsafe-settlement";

    /// $4,000.00 and $4,400.00 at the feed's 8 decimals.
    int256 internal constant P0 = 4_000e8;
    int256 internal constant P1 = 4_400e8;

    event OrderFilled(
        uint256 indexed orderId, address indexed trader, uint32 indexed assetId,
        AssetExchange.Side side, uint256 amountIn, uint256 amountOut, uint256 fee,
        uint80 fillRound, int256 fillPrice
    );
    event OrderRefunded(uint256 indexed orderId, address indexed trader, AssetExchange.RefundReason reason);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        gold = new MockFeed(8);
        gold.push(P0);

        ex = new AssetExchange(IERC20(address(usdc)), forwarder);
        ex.setExpectedAuthor(address(this));
        ex.setExpectedWorkflowName(WF);
        ex.listAsset("XAU", "Synthetic Gold", gold);
        (,, address token,,) = ex.asset(0);
        sXAU = SyntheticAsset(token);

        usdc.mint(address(this), 100_000e6);
        usdc.approve(address(ex), type(uint256).max);
        ex.fundReserve(10_000e6);

        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? alice : bob;
            usdc.mint(who, 10_000e6);
            vm.prank(who);
            usdc.approve(address(ex), type(uint256).max);
        }
    }

    // --- helpers ------------------------------------------------------------

    function _later() internal { vm.warp(block.timestamp + 1 hours); }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _buy(address who, uint256 usdcIn) internal returns (uint256) {
        vm.prank(who);
        return ex.placeBuy(0, usdcIn);
    }

    function _meta() internal view returns (bytes memory) {
        return abi.encodePacked(bytes32(0), ex.getExpectedWorkflowName(), address(this));
    }

    // --- listing --------------------------------------------------------------

    function test_listAsset_deploysAnExchangeOwnedToken() public view {
        (string memory symbol, address feed,, uint8 dec, bool active) = ex.asset(0);
        assertEq(symbol, "XAU");
        assertEq(feed, address(gold));
        assertEq(dec, 8);
        assertTrue(active);
        assertEq(sXAU.symbol(), "sXAU");
        assertEq(sXAU.exchange(), address(ex));
    }

    function test_listAsset_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        ex.listAsset("CSPX", "Synthetic S&P 500", gold);
    }

    function test_token_onlyExchangeMintsOrBurns() public {
        vm.expectRevert(SyntheticAsset.OnlyExchange.selector);
        sXAU.mint(alice, 1);
        vm.expectRevert(SyntheticAsset.OnlyExchange.selector);
        sXAU.burn(alice, 1);
    }

    // --- the rule: the NEXT new price, never a known one --------------------------

    function test_buy_waitsForANewPrice() public {
        uint256 id = _buy(alice, 1_000e6);
        (bool found,,) = ex.nextFill(id);
        assertFalse(found, "nothing has been published since the order");

        ex.fill(_ids(id));
        assertEq(uint8(ex.order(id).status), uint8(AssetExchange.Status.Pending));
        assertEq(sXAU.balanceOf(alice), 0);
    }

    /// The weekend case: rounds keep coming with a fresh timestamp and the same
    /// price. A staleness check on `updatedAt` would accept them; this must not.
    function test_buy_ignoresHeartbeatsThatRepeatThePrice() public {
        uint256 id = _buy(alice, 1_000e6);
        for (uint256 i = 0; i < 24; i++) {
            _later();
            gold.push(P0);
        }
        (bool found,,) = ex.nextFill(id);
        assertFalse(found, "24 fresh rounds, not one new price");
    }

    function test_buy_fillsAtTheFirstNewPrice() public {
        uint256 id = _buy(alice, 1_000e6);
        _later();
        gold.push(P0);           // heartbeat
        _later();
        uint80 r = gold.push(P1); // the first genuine change

        uint256 fee = 1_000e6 * 30 / 10_000;
        // (1000 - 3) USDC at $4,400 = 0.2265909... tokens, 18 decimals.
        uint256 expected = (1_000e6 - fee) * 1e20 / uint256(P1);

        vm.expectEmit(true, true, true, true);
        emit OrderFilled(id, alice, 0, AssetExchange.Side.Buy, 1_000e6, expected, fee, r, P1);
        ex.fill(_ids(id));

        assertEq(sXAU.balanceOf(alice), expected);
        assertEq(ex.escrowedUsdc(), 0);
    }

    /// Filling late must not let anyone pick a better price. The fill round is
    /// fixed by the order, not by when `fill` is called.
    function test_fillingLateStillUsesTheFirstNewPrice() public {
        uint256 id = _buy(alice, 1_000e6);
        _later();
        uint80 first = gold.push(P1);
        _later();
        gold.push(5_000e8);
        _later();
        gold.push(3_000e8);

        ex.fill(_ids(id));
        AssetExchange.Order memory o = ex.order(id);
        assertEq(o.fillRound, first);
        assertEq(o.fillPrice, P1);
    }

    /// A price update published in the same block as the order is one its
    /// author could have seen pending. It does not count, and neither do the
    /// heartbeats that repeat it.
    function test_roundInTheSameBlockAsTheOrderDoesNotCount() public {
        uint256 id = _buy(alice, 1_000e6);
        gold.push(P1); // same timestamp as the order
        _later();
        gold.push(P1); // heartbeat of the front-run price
        (bool found,,) = ex.nextFill(id);
        assertFalse(found, "no change has been published after the order");

        _later();
        uint80 r = gold.push(4_200e8);
        (bool ok, uint80 round, int256 price) = ex.nextFill(id);
        assertTrue(ok);
        assertEq(round, r);
        assertEq(price, 4_200e8);
    }

    function test_walkIsBounded() public {
        uint256 id = _buy(alice, 1_000e6);
        for (uint256 i = 0; i < ex.MAX_WALK(); i++) {
            _later();
            gold.push(P0);
        }
        _later();
        gold.push(P1); // round MAX_WALK + 1 after the order
        (bool found,,) = ex.nextFill(id);
        assertFalse(found, "past the walk bound the order waits, and can be cancelled");
    }

    function test_newAggregatorPhaseIsNotSearched() public {
        uint256 id = _buy(alice, 1_000e6);
        _later();
        gold.newPhase(P1);
        (bool found,,) = ex.nextFill(id);
        assertFalse(found);
    }

    // --- sells and the reserve -------------------------------------------------

    function _holdGold(address who, uint256 usdcIn) internal returns (uint256 tokens) {
        uint256 id = _buy(who, usdcIn);
        _later();
        gold.push(P1);
        ex.fill(_ids(id));
        tokens = sXAU.balanceOf(who);
    }

    function test_sell_burnsNowAndPaysAtTheNextNewPrice() public {
        uint256 tokens = _holdGold(alice, 1_000e6);
        vm.prank(alice);
        uint256 id = ex.placeSell(0, tokens);
        assertEq(sXAU.balanceOf(alice), 0, "burned at placement");

        _later();
        gold.push(4_840e8); // +10%
        uint256 before = usdc.balanceOf(alice);
        ex.fill(_ids(id));

        uint256 gross = tokens * 4_840e8 / 1e20;
        uint256 payout = gross - gross * 30 / 10_000;
        assertEq(usdc.balanceOf(alice) - before, payout);
    }

    function test_sell_theReserveIsNotAllowedToPayOutEscrow() public {
        uint256 tokens = _holdGold(alice, 1_000e6);
        // Bob's pending buy sits in the contract but is not the reserve's.
        _buy(bob, 5_000e6);
        assertEq(ex.escrowedUsdc(), 5_000e6);
        uint256 available = ex.reserveAvailable();
        assertEq(available, usdc.balanceOf(address(ex)) - 5_000e6);
        assertGt(tokens, 0);
    }

    /// When the reserve cannot cover a sell, the seller gets their tokens back
    /// instead of a partial payment or an IOU.
    function test_sell_refundsTokensWhenTheReserveCannotPay() public {
        uint256 tokens = _holdGold(alice, 1_000e6);
        vm.prank(alice);
        uint256 id = ex.placeSell(0, tokens);

        _later();
        gold.push(1_000_000e8); // the asset goes up 227x

        vm.expectEmit(true, true, false, true);
        emit OrderRefunded(id, alice, AssetExchange.RefundReason.InsufficientReserve);
        ex.fill(_ids(id));

        assertEq(sXAU.balanceOf(alice), tokens, "tokens returned");
        assertEq(uint8(ex.order(id).status), uint8(AssetExchange.Status.Refunded));
    }

    // --- cancelling ---------------------------------------------------------------

    function test_cancel_onlyAfterTimeout_andOnlyByTheTrader() public {
        uint256 id = _buy(alice, 1_000e6);

        vm.prank(alice);
        vm.expectRevert(AssetExchange.TooEarlyToCancel.selector);
        ex.cancel(id);

        vm.warp(block.timestamp + ex.CANCEL_AFTER());
        vm.prank(bob);
        vm.expectRevert(AssetExchange.NotYourOrder.selector);
        ex.cancel(id);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        ex.cancel(id);
        assertEq(usdc.balanceOf(alice) - before, 1_000e6, "refunded in full, no fee");
        assertEq(ex.escrowedUsdc(), 0);
        assertEq(ex.pendingOrderIds().length, 0);
    }

    function test_cancel_aSellGivesTheTokensBack() public {
        uint256 tokens = _holdGold(alice, 1_000e6);
        vm.prank(alice);
        uint256 id = ex.placeSell(0, tokens);
        vm.warp(block.timestamp + ex.CANCEL_AFTER());
        vm.prank(alice);
        ex.cancel(id);
        assertEq(sXAU.balanceOf(alice), tokens);
    }

    // --- the DON's route ------------------------------------------------------------

    function test_report_fillsLikeFill() public {
        uint256 id = _buy(alice, 1_000e6);
        _later();
        gold.push(P1);

        bytes memory meta = _meta(); // an external read — must not eat the prank
        vm.prank(forwarder);
        ex.onReport(meta, abi.encode(_ids(id)));
        assertEq(uint8(ex.order(id).status), uint8(AssetExchange.Status.Filled));
    }

    function test_report_onlyFromTheForwarder() public {
        bytes memory meta = _meta();
        vm.prank(alice);
        vm.expectRevert();
        ex.onReport(meta, abi.encode(_ids(0)));
    }

    /// The list the DON reads names only orders that would fill now — and a
    /// wrong list costs a skip, never a wrong price.
    function test_fillableOrders_listsOnlyWhatWouldFill() public {
        uint256 a = _buy(alice, 1_000e6);
        _later();
        gold.push(P1);
        uint256 b = _buy(bob, 1_000e6); // placed after the new price

        uint256[] memory ids = ex.fillableOrders(8);
        assertEq(ids.length, 1);
        assertEq(ids[0], a);

        uint256[] memory both = new uint256[](2);
        both[0] = a;
        both[1] = b;
        ex.fill(both);
        assertEq(uint8(ex.order(a).status), uint8(AssetExchange.Status.Filled));
        assertEq(uint8(ex.order(b).status), uint8(AssetExchange.Status.Pending));
    }

    function test_pendingListStaysConsistent() public {
        uint256 a = _buy(alice, 100e6);
        uint256 b = _buy(bob, 200e6);
        uint256 c = _buy(alice, 300e6);
        _later();
        gold.push(P1);
        ex.fill(_ids(b));
        uint256[] memory left = ex.pendingOrderIds();
        assertEq(left.length, 2);
        assertTrue((left[0] == a && left[1] == c) || (left[0] == c && left[1] == a));
    }

    function test_inactiveAssetTakesNoNewOrders() public {
        ex.setAssetActive(0, false);
        vm.prank(alice);
        vm.expectRevert(AssetExchange.AssetInactive.selector);
        ex.placeBuy(0, 100e6);
    }
}
