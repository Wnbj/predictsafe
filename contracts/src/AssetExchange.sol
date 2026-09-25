// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/// @notice The subset of a Chainlink aggregator proxy this contract reads.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
}

/**
 * @title SyntheticAsset
 * @notice An ERC-20 that only its exchange can mint or burn. Holding one is a
 *         claim on the exchange's reserve at the asset's feed price — it is not
 *         a share of anything, and nothing stands behind it but that reserve.
 */
contract SyntheticAsset is ERC20 {
    address public immutable exchange;

    error OnlyExchange();

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        exchange = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != exchange) revert OnlyExchange();
        _burn(from, amount);
    }
}

/**
 * @title AssetExchange
 * @notice Buy and sell synthetic tokens of real-world assets — gold, an S&P 500
 *         fund — priced by Chainlink Data Feeds.
 *
 *  THE WHOLE DESIGN IS ONE RULE: AN ORDER FILLS AT THE FIRST NEW PRICE
 *  PUBLISHED AFTER IT, NEVER AT A PRICE ANYONE ALREADY KNOWS.
 *
 *  Trading at the latest feed price is the obvious design and it gives money
 *  away. Measured on Sepolia in September 2026: CSPX/USD publishes about once a
 *  day and republishes the same price every Sunday; XAU/USD publishes hourly
 *  but put out 24 rounds on one Saturday without a single new price. Anyone
 *  watching the real market knows where the next update will land. Buying
 *  before it and selling after it drains whoever is on the other side — here,
 *  the reserve. Mutual funds solved the same problem the same way: an order
 *  fills at the NEXT computed price, never the last one.
 *
 *  "New" is stricter than "later", in two ways that both came out of the
 *  measurement:
 *
 *   - A round that repeats the previous round's price is a heartbeat, not
 *     information. Its timestamp is fresh, so a staleness check on `updatedAt`
 *     would wave it through; the price is what has to have changed.
 *   - A round published in the same block as the order does not count. Someone
 *     who saw the price update pending could otherwise place an order in front
 *     of it and fill at a price they had already read.
 *
 *  THE CONTRACT FINDS THE FILL PRICE ITSELF. The report a Chainlink DON
 *  delivers carries order ids and nothing else — no price, no round. For every
 *  id the contract walks the feed from the order's own round forward and takes
 *  the first genuine change. Because that round is fixed by the order, not by
 *  when anyone asks, WHEN a fill happens cannot change WHAT it pays, and
 *  `fill` is open to anyone: the DON is a convenient keeper, not a party that
 *  could steer a price.
 *
 *  THE RESERVE IS THE COUNTERPARTY. When the asset rises, sellers are owed
 *  more mUSDC than buyers paid in, and the difference comes out of the
 *  reserve. A sell the reserve cannot cover is refunded — the tokens are given
 *  back — rather than paid partially or left owing. That is an honest failure,
 *  and it is visible: `reserveAvailable()` says how much can be paid out now.
 *
 *  NOT AUDITED. POC only, on a testnet, with a freely mintable stake token.
 */
contract AssetExchange is ReceiverTemplate {
    using SafeERC20 for IERC20;

    // --- types -------------------------------------------------------------

    enum Side { Buy, Sell }
    enum Status { Pending, Filled, Refunded }

    /// Why an order came back instead of filling.
    enum RefundReason { Timeout, InsufficientReserve }

    struct Asset {
        string symbol;
        IPriceFeed feed;
        SyntheticAsset token;
        uint8 feedDecimals;
        bool active;
    }

    struct Order {
        address trader;
        uint32 assetId;
        Side side;
        Status status;
        /// The feed's latest round when the order was placed. The fill round
        /// is searched for strictly after it.
        uint80 placedRound;
        uint64 placedAt;
        /// mUSDC for a buy, asset tokens for a sell.
        uint256 amountIn;
        /// Asset tokens for a buy, mUSDC for a sell. Zero until filled.
        uint256 amountOut;
        uint256 fee;
        uint80 fillRound;
        int256 fillPrice;
    }

    // --- constants ---------------------------------------------------------

    /// 0.3%, charged on both sides and kept in the reserve.
    uint256 public constant FEE_BPS = 30;

    /// After this long a pending order can be taken back by its trader. A
    /// daily feed that stops, or an aggregator upgrade that restarts its round
    /// numbering, must not lock anyone's money for ever.
    uint64 public constant CANCEL_AFTER = 7 days;

    /**
     * How many rounds the search for a new price will walk.
     *
     * The longest quiet stretch measured was a weekend of hourly gold rounds —
     * about 46 heartbeats between Friday's last trade and Sunday's first.
     * 100 covers that twice over, and bounds the gas a fill can cost. An order
     * whose next price lies further out simply waits, and can be cancelled.
     */
    uint256 public constant MAX_WALK = 100;

    /// At most this many orders per call, so one fill stays within a block.
    uint256 public constant MAX_FILLS_PER_CALL = 8;

    // --- storage -----------------------------------------------------------

    IERC20 public immutable usdc;
    uint8 public immutable usdcDecimals;

    Asset[] internal _assets;
    Order[] internal _orders;

    /// mUSDC held for buy orders that have not filled. Not available to pay
    /// sellers, because each of those orders may still be refunded.
    uint256 public escrowedUsdc;

    uint256[] internal _pending;
    mapping(uint256 => uint256) internal _pendingSlot; // orderId => index + 1

    // --- events ------------------------------------------------------------

    event AssetListed(uint32 indexed assetId, string symbol, address feed, address token);
    event AssetActiveSet(uint32 indexed assetId, bool active);
    event ReserveFunded(address indexed from, uint256 amount);

    event OrderPlaced(
        uint256 indexed orderId,
        address indexed trader,
        uint32 indexed assetId,
        Side side,
        uint256 amountIn,
        uint80 placedRound,
        int256 priceAtPlacement
    );
    event OrderFilled(
        uint256 indexed orderId,
        address indexed trader,
        uint32 indexed assetId,
        Side side,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint80 fillRound,
        int256 fillPrice
    );
    event OrderRefunded(uint256 indexed orderId, address indexed trader, RefundReason reason);

    // --- errors ------------------------------------------------------------

    error UnknownAsset();
    error AssetInactive();
    error ZeroAmount();
    error BadFeedPrice();
    error NotPending();
    error NotYourOrder();
    error TooEarlyToCancel();
    error TooManyOrders();

    constructor(IERC20 _usdc, address _forwarder) ReceiverTemplate(_forwarder) {
        usdc = _usdc;
        usdcDecimals = IERC20Metadata(address(_usdc)).decimals();
    }

    // --- assets ------------------------------------------------------------

    /**
     * List an asset and deploy its token. Owner-only because the feed decides
     * every price: a caller-supplied feed would let anyone price an asset from
     * a contract they control.
     */
    function listAsset(string calldata symbol, string calldata name, IPriceFeed feed)
        external
        onlyOwner
        returns (uint32 assetId)
    {
        if (address(feed) == address(0)) revert UnknownAsset();
        (, int256 answer,,,) = feed.latestRoundData();
        if (answer <= 0) revert BadFeedPrice();

        SyntheticAsset token = new SyntheticAsset(name, string.concat("s", symbol));
        assetId = uint32(_assets.length);
        _assets.push(Asset({
            symbol: symbol,
            feed: feed,
            token: token,
            feedDecimals: feed.decimals(),
            active: true
        }));
        emit AssetListed(assetId, symbol, address(feed), address(token));
    }

    /// Stop new orders on an asset, e.g. if its feed is retired. Pending
    /// orders are untouched: they still fill, or can be cancelled.
    function setAssetActive(uint32 assetId, bool active) external onlyOwner {
        if (assetId >= _assets.length) revert UnknownAsset();
        _assets[assetId].active = active;
        emit AssetActiveSet(assetId, active);
    }

    function fundReserve(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveFunded(msg.sender, amount);
    }

    // --- orders ------------------------------------------------------------

    /// Pay `usdcIn` now; receive asset tokens at the next new price.
    function placeBuy(uint32 assetId, uint256 usdcIn) external returns (uint256 orderId) {
        if (usdcIn == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        escrowedUsdc += usdcIn;
        orderId = _place(assetId, Side.Buy, usdcIn);
    }

    /// Give up `tokensIn` now; receive mUSDC at the next new price. The tokens
    /// are burned immediately and re-minted if the order is refunded.
    function placeSell(uint32 assetId, uint256 tokensIn) external returns (uint256 orderId) {
        if (tokensIn == 0) revert ZeroAmount();
        _assetOrRevert(assetId).token.burn(msg.sender, tokensIn);
        orderId = _place(assetId, Side.Sell, tokensIn);
    }

    function _place(uint32 assetId, Side side, uint256 amountIn) internal returns (uint256 orderId) {
        Asset storage a = _assetOrRevert(assetId);
        if (!a.active) revert AssetInactive();
        (uint80 round, int256 answer,,,) = a.feed.latestRoundData();
        if (answer <= 0) revert BadFeedPrice();

        orderId = _orders.length;
        _orders.push(Order({
            trader: msg.sender,
            assetId: assetId,
            side: side,
            status: Status.Pending,
            placedRound: round,
            placedAt: uint64(block.timestamp),
            amountIn: amountIn,
            amountOut: 0,
            fee: 0,
            fillRound: 0,
            fillPrice: 0
        }));
        _pending.push(orderId);
        _pendingSlot[orderId] = _pending.length;
        emit OrderPlaced(orderId, msg.sender, assetId, side, amountIn, round, answer);
    }

    /// Take back an order that has waited `CANCEL_AFTER` without a new price.
    function cancel(uint256 orderId) external {
        Order storage o = _orders[orderId];
        if (o.trader != msg.sender) revert NotYourOrder();
        if (o.status != Status.Pending) revert NotPending();
        if (block.timestamp < o.placedAt + CANCEL_AFTER) revert TooEarlyToCancel();
        _refund(orderId, RefundReason.Timeout);
    }

    // --- filling -----------------------------------------------------------

    /**
     * Fill whichever of `orderIds` have a new price available. Open to anyone:
     * the fill round is fixed by each order, so the caller cannot influence the
     * price. Orders with nothing to fill yet are skipped, not reverted, so one
     * early id does not block the rest.
     */
    function fill(uint256[] calldata orderIds) external {
        _fillMany(orderIds);
    }

    /// The DON's route to `fill`: a report is `abi.encode(uint256[] orderIds)`.
    function _processReport(bytes calldata report) internal override {
        _fillMany(abi.decode(report, (uint256[])));
    }

    function _fillMany(uint256[] memory orderIds) internal {
        if (orderIds.length > MAX_FILLS_PER_CALL) revert TooManyOrders();
        for (uint256 i = 0; i < orderIds.length; i++) {
            uint256 id = orderIds[i];
            if (id >= _orders.length || _orders[id].status != Status.Pending) continue;
            (bool found, uint80 round, int256 price) = _firstNewPrice(id);
            if (found) _settle(id, round, price);
        }
    }

    function _settle(uint256 orderId, uint80 round, int256 price) internal {
        Order storage o = _orders[orderId];
        Asset storage a = _assets[o.assetId];
        uint256 scale = 10 ** (18 + uint256(a.feedDecimals) - uint256(usdcDecimals));

        if (o.side == Side.Buy) {
            uint256 fee = o.amountIn * FEE_BPS / 10_000;
            uint256 tokensOut = Math.mulDiv(o.amountIn - fee, scale, uint256(price));
            escrowedUsdc -= o.amountIn;
            o.fee = fee;
            o.amountOut = tokensOut;
            a.token.mint(o.trader, tokensOut);
        } else {
            uint256 gross = Math.mulDiv(o.amountIn, uint256(price), scale);
            uint256 fee = gross * FEE_BPS / 10_000;
            uint256 payout = gross - fee;
            if (payout > reserveAvailable()) {
                _refund(orderId, RefundReason.InsufficientReserve);
                return;
            }
            o.fee = fee;
            o.amountOut = payout;
            usdc.safeTransfer(o.trader, payout);
        }

        o.status = Status.Filled;
        o.fillRound = round;
        o.fillPrice = price;
        _removePending(orderId);
        emit OrderFilled(orderId, o.trader, o.assetId, o.side, o.amountIn, o.amountOut, o.fee, round, price);
    }

    function _refund(uint256 orderId, RefundReason reason) internal {
        Order storage o = _orders[orderId];
        o.status = Status.Refunded;
        _removePending(orderId);
        if (o.side == Side.Buy) {
            escrowedUsdc -= o.amountIn;
            usdc.safeTransfer(o.trader, o.amountIn);
        } else {
            _assets[o.assetId].token.mint(o.trader, o.amountIn);
        }
        emit OrderRefunded(orderId, o.trader, reason);
    }

    /**
     * The first round after `orderId` that carries a genuine price change:
     * published strictly after the order's block, with an answer different from
     * the round immediately before it.
     *
     * A round in a new aggregator phase is not searched: round numbers restart
     * there, so "after" stops meaning anything. Such an order waits, and can be
     * cancelled after `CANCEL_AFTER`.
     */
    function _firstNewPrice(uint256 orderId) internal view returns (bool, uint80, int256) {
        Order storage o = _orders[orderId];
        IPriceFeed feed = _assets[o.assetId].feed;
        (uint80 latest,,,,) = feed.latestRoundData();
        if (latest >> 64 != o.placedRound >> 64 || latest <= o.placedRound) return (false, 0, 0);

        (bool ok, int256 prev,) = _round(feed, o.placedRound);
        if (!ok) return (false, 0, 0);

        uint80 last = latest - o.placedRound > MAX_WALK ? o.placedRound + uint80(MAX_WALK) : latest;
        for (uint80 r = o.placedRound + 1; r <= last; r++) {
            (bool exists, int256 answer, uint256 updatedAt) = _round(feed, r);
            if (!exists) return (false, 0, 0);
            if (updatedAt > o.placedAt && answer != prev && answer > 0) return (true, r, answer);
            prev = answer;
        }
        return (false, 0, 0);
    }

    function _round(IPriceFeed feed, uint80 roundId) internal view returns (bool, int256, uint256) {
        try feed.getRoundData(roundId) returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            return (updatedAt != 0, answer, updatedAt);
        } catch {
            return (false, 0, 0);
        }
    }

    function _removePending(uint256 orderId) internal {
        uint256 slot = _pendingSlot[orderId];
        if (slot == 0) return;
        uint256 lastId = _pending[_pending.length - 1];
        _pending[slot - 1] = lastId;
        _pendingSlot[lastId] = slot;
        _pending.pop();
        delete _pendingSlot[orderId];
    }

    function _assetOrRevert(uint32 assetId) internal view returns (Asset storage) {
        if (assetId >= _assets.length) revert UnknownAsset();
        return _assets[assetId];
    }

    // --- views ---------------------------------------------------------------

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    function asset(uint32 assetId)
        external
        view
        returns (string memory symbol, address feed, address token, uint8 feedDecimals, bool active)
    {
        Asset storage a = _assetOrRevert(assetId);
        return (a.symbol, address(a.feed), address(a.token), a.feedDecimals, a.active);
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function order(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function pendingOrderIds() external view returns (uint256[] memory) {
        return _pending;
    }

    /// mUSDC that can be paid to sellers right now.
    function reserveAvailable() public view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        return balance > escrowedUsdc ? balance - escrowedUsdc : 0;
    }

    /// Whether `orderId` has a new price to fill at, and which.
    function nextFill(uint256 orderId) external view returns (bool found, uint80 round, int256 price) {
        if (_orders[orderId].status != Status.Pending) return (false, 0, 0);
        return _firstNewPrice(orderId);
    }

    /**
     * Pending orders that would fill if `fill` were called now, at most `max`.
     * This is what the DON reads on its schedule; `fill` recomputes everything
     * itself, so a stale or wrong list can only cost a skipped id, never a
     * wrong price.
     */
    function fillableOrders(uint256 max) external view returns (uint256[] memory ids) {
        if (max > MAX_FILLS_PER_CALL) max = MAX_FILLS_PER_CALL;
        uint256[] memory found = new uint256[](max);
        uint256 n;
        for (uint256 i = 0; i < _pending.length && n < max; i++) {
            (bool ok,,) = _firstNewPrice(_pending[i]);
            if (ok) found[n++] = _pending[i];
        }
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = found[i];
    }
}
