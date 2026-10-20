// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/**
 * @title AmmMarket
 * @notice A binary prediction market priced by a constant-product automated
 *         market maker, instead of parimutuel pooling.
 *
 *  WHY THIS EXISTS ALONGSIDE ParimutuelMarket RATHER THAN REPLACING IT:
 *  in a parimutuel market you do not buy at a price, you join a pool. Your
 *  share of the pot is only fixed at settlement, so every later stake on your
 *  own side dilutes you — stake when the odds look good and they can be worse
 *  by the time the market closes, through nothing you did. Here, buying gives
 *  you a fixed number of shares, each redeemable for exactly one unit of
 *  collateral if you are right. Your price is whatever you paid per share, and
 *  nothing anyone does afterwards can change it. That is the whole difference,
 *  and it is a different product rather than a tuning of the old one.
 *
 *  HOW SOLVENCY IS GUARANTEED, not merely tested:
 *  collateral only ever enters by minting COMPLETE SETS — one unit in mints
 *  one YES and one NO. So at all times
 *
 *      totalYesShares == totalNoShares == collateral held for this market
 *
 *  and every share, wherever it sits, is backed by its own unit. Whichever
 *  side wins, the claims against the market are exactly the shares of that
 *  side, which is exactly the collateral. The AMM cannot be drained by a
 *  trade because trading only ever moves shares between the pool and a
 *  trader; it never mints a share without the unit behind it. The fuzz tests
 *  assert this invariant directly rather than sampling outcomes.
 *
 *  ANY NUMBER OF LIQUIDITY PROVIDERS. Depositing scales both reserves by a
 *  common factor, which is the only way to add depth without moving the price,
 *  and mints LP shares in proportion. Because the deposit mints complete sets
 *  while the pool can only absorb them in its own ratio, the depositor keeps
 *  the remainder as a real directional position — exactly as the market's
 *  creator does when they open away from even money. After settlement each
 *  provider withdraws `winningReserve * theirShares / totalShares`, floored,
 *  so the sum can never exceed what the pool holds.
 *
 *  A TRADING FEE IS RETAINED AS COMPLETE SETS. The fee never leaves as a
 *  separate balance to be accounted for; it simply stays in both reserves,
 *  which raises the constant product and therefore the value of every LP
 *  share. That makes fee accrual outcome-independent — whichever side wins,
 *  the winning reserve carries the fees with it — and it means a late
 *  provider mints fewer shares per unit deposited, so they cannot claim
 *  fees earned before they arrived. Both properties fall out of the
 *  arithmetic rather than needing a checkpoint mechanism.
 *
 *  Settlement is deliberately event-compatible with CryptoMarket, so the same
 *  CRE workflow handler settles both — this contract's address is simply added
 *  to that trigger's address list.
 *
 *  NOT AUDITED. POC only.
 */
contract AmmMarket is ReceiverTemplate {
    using SafeERC20 for IERC20;

    // --- types -------------------------------------------------------------

    enum Asset { BTC, ETH }
    enum Status { Open, SettlementRequested, Settled, Void }
    enum Outcome { Unset, Yes, No, Void }

    struct Market {
        string  question;
        Asset   asset;
        uint64  strikePrice;   // 8 decimals
        uint64  closeTime;     // no trading after this
        uint64  expiryTime;    // the price is measured here
        uint64  settleAfter;   // earliest settlement request
        Status  status;
        Outcome outcome;
        uint16  feeBps;        // taken on every trade, retained by the pool
        int256  observedValue;
        bytes32 evidenceHash;
        /**
         * Whoever opened the market. Metadata only — it carries no powers and
         * nothing branches on it. Liquidity is tracked by `lpShares` alone, so
         * the creator is simply the first provider.
         */
        address creator;
        uint256 yesReserve;    // YES shares held by the pool
        uint256 noReserve;     // NO shares held by the pool
        uint256 collateral;    // complete sets minted == token units held
        uint256 totalLpShares; // denominator for every provider's claim
    }

    /**
     * The pool as the outside world reads it. Returned as a named struct rather
     * than a positional tuple on purpose: callers decode it by field, so adding
     * a field later cannot silently shift what an existing reader sees. That
     * failure has no error attached to it anywhere — the decode simply yields
     * the wrong number — which makes it the worst kind available here.
     */
    struct PoolView {
        uint8   status;
        uint8   outcome;
        int256  observedValue;
        bytes32 evidenceHash;
        uint256 yesReserve;
        uint256 noReserve;
        uint256 collateral;
        uint256 totalLpShares;
        uint16  feeBps;
        address creator;
    }

    // --- storage -----------------------------------------------------------

    IERC20 public immutable token;

    uint256 public marketCount;
    /**
     * Internal, with two narrow views below instead of one generated getter.
     * A public getter for the whole struct blows the stack even under via_ir,
     * and splitting it the way ParimutuelMarket splits core from terms is
     * better for callers anyway — the UI wants the pool numbers far more often
     * than it wants the question string.
     */
    mapping(uint256 => Market) internal marketData;
    mapping(uint256 => mapping(address => uint256)) public yesShares;
    mapping(uint256 => mapping(address => uint256)) public noShares;
    mapping(uint256 => mapping(address => bool))    public redeemed;

    /**
     * Liquidity, deliberately shaped like the share mappings above rather than
     * like something new: a balance per provider, a one-shot flag per provider,
     * and an aggregate denominator on the market. A provider therefore has two
     * INDEPENDENT claims on a settled market — `withdrawLiquidity` for their
     * slice of the pool and `redeem` for the residual shares they hold — with
     * separate guards, and doing one does not consume the other.
     */
    mapping(uint256 => mapping(address => uint256)) public lpShares;
    mapping(uint256 => mapping(address => bool))    public lpWithdrawn;

    /// Matches CryptoMarket, so the same oracle path can settle this contract.
    uint64 public constant SETTLEMENT_DELAY = 60;

    /**
     * A market seeded with dust would have `totalLpShares` so small that the
     * next provider's proportional mint floors to nothing and their deposit is
     * taken for free. One whole token is far above where that bites.
     */
    uint256 public constant MIN_LIQUIDITY = 1e6;

    /// 5%. High enough to be useless to quote against, low enough to be a fee.
    uint16 public constant MAX_FEE_BPS = 500;

    // --- events ------------------------------------------------------------

    event MarketCreated(
        uint256 indexed marketId,
        uint8   asset,
        uint64  strikePrice,
        uint64  expiryTime,
        uint256 liquidity,
        address creator,
        uint16  feeBps
    );
    /// @dev `fee` is the part of `collateralIn` the pool kept.
    event Bought(
        uint256 indexed marketId,
        address indexed buyer,
        bool    isYes,
        uint256 collateralIn,
        uint256 sharesOut,
        uint256 fee
    );
    event Settled(uint256 indexed marketId, Outcome outcome, int256 observedValue, bytes32 evidenceHash);
    /// @dev `collateralOut` is what the seller received, i.e. already net of `fee`.
    event Sold(
        uint256 indexed marketId,
        address indexed seller,
        bool    isYes,
        uint256 sharesIn,
        uint256 collateralOut,
        uint256 fee
    );
    event Redeemed(uint256 indexed marketId, address indexed holder, uint256 amount);

    /**
     * Emitted by `newMarket` as well as `addLiquidity`, so a reader never has
     * to treat the creator's seed as a special case. `totalLpShares` is the
     * value AFTER this deposit, which is what lets an off-chain replay
     * reconstruct every provider's fraction at any block — and therefore
     * attribute each trade's fee to whoever was actually providing at the time.
     */
    event LiquidityAdded(
        uint256 indexed marketId,
        address indexed provider,
        uint256 collateralIn,
        uint256 lpSharesMinted,
        uint256 totalLpShares,
        uint256 yesResidual,
        uint256 noResidual
    );
    /// @dev Its own event, not a reuse of `Redeemed`: a claim on the pool and a
    ///      redemption of shares are different money, and a reader that cannot
    ///      tell them apart double-counts.
    event LiquidityWithdrawn(
        uint256 indexed marketId,
        address indexed provider,
        uint256 lpShares,
        uint256 amount
    );

    /// @dev Byte-identical to CryptoMarket.SettlementRequested on purpose.
    event SettlementRequested(
        uint256 indexed marketId,
        uint8   asset,
        uint64  strikePrice,
        uint64  expiryTime
    );

    // --- errors ------------------------------------------------------------

    error BadStatus();
    error BadExpiry();
    error BadStrike();
    error NoLiquidity();
    error TooLate();
    error TooEarly();
    error NothingToRedeem();
    error AlreadyRedeemed();
    error SlippageTooHigh();
    error NotEnoughShares();
    error BadOpeningPrice();
    // Distinct rather than folded into BadStatus/AlreadyRedeemed: the existing
    // overloading already makes reverts here harder to read than they should be.
    error NotAnLp();
    error AlreadyWithdrawn();
    error BadFee();

    constructor(IERC20 _token, address _forwarder) ReceiverTemplate(_forwarder) {
        token = _token;
    }

    // --- market lifecycle --------------------------------------------------

    /**
     * @param liquidity collateral the caller seeds the pool with, minting one
     *                  YES and one NO share per unit.
     * @param openingYesPriceBps the price the market should open at, 100–9900.
     *
     * OPENING AT A CHOSEN PRICE, rather than always at even money.
     *
     * The first version always split the minted sets evenly, so every market
     * opened at 50% whatever its strike. That is defensible for a lone market
     * — the maker takes no view — and useless for a strike ladder, where five
     * rungs all reading 50% say nothing about where the price will land. The
     * only way to give the ladder a shape was to trade every rung by hand,
     * which cost `L·(sqrt(p/(1-p)) - 1)` per rung and ran to more than the
     * liquidity itself on the far strikes.
     *
     * So the pool takes reserves in the ratio `y:n = (1-p):p`, scaled so the
     * larger side uses the whole seed, and the maker KEEPS the remainder of
     * the other side. That leftover is a real position: a maker who opens a
     * market at 85% ends up holding YES shares, which is exactly what having
     * that view means. They are not quoting for free.
     *
     * The invariant is untouched — every minted share is still accounted for,
     * either in the pool or in the maker's own balance — so
     * `totalYes == totalNo == collateral` continues to hold.
     *
     * @param feeBps taken on every trade and retained by the pool. Fixed here
     *               and never changeable afterwards: it is a term the trader
     *               read in the quote, so moving it under them would be a rug
     *               that surfaces only as a confusing slippage revert.
     */
    function newMarket(
        string calldata question,
        Asset asset,
        uint64 strikePrice,
        uint64 closeTime,
        uint64 expiryTime,
        uint256 liquidity,
        uint256 openingYesPriceBps,
        uint16 feeBps
    ) external virtual returns (uint256 marketId) {
        return _createMarket(
            question, asset, strikePrice, closeTime, expiryTime, liquidity, openingYesPriceBps, feeBps, msg.sender
        );
    }

    /**
     * The whole of `newMarket`, with the provider named rather than taken from
     * `msg.sender` — so a contract built on this one (SportsMarket) can open
     * markets it funds itself. When the provider is this contract, the
     * liquidity is already here and nothing is pulled.
     */
    function _createMarket(
        string memory question,
        Asset asset,
        uint64 strikePrice,
        uint64 closeTime,
        uint64 expiryTime,
        uint256 liquidity,
        uint256 openingYesPriceBps,
        uint16 feeBps,
        address provider
    ) internal returns (uint256 marketId) {
        if (strikePrice == 0) revert BadStrike();
        if (closeTime > expiryTime) revert BadExpiry();
        if (liquidity < MIN_LIQUIDITY) revert NoLiquidity();
        if (feeBps > MAX_FEE_BPS) revert BadFee();
        // Bounded away from the ends: at 0 or 10000 one reserve would be zero,
        // the constant product would collapse and no trade could ever price.
        if (openingYesPriceBps < 100 || openingYesPriceBps > 9_900) revert BadOpeningPrice();

        if (provider != address(this)) token.safeTransferFrom(provider, address(this), liquidity);

        marketId = marketCount++;
        Market storage m = marketData[marketId];
        m.question = question;
        m.asset = asset;
        m.strikePrice = strikePrice;
        m.closeTime = closeTime;
        m.expiryTime = expiryTime;
        m.settleAfter = expiryTime + SETTLEMENT_DELAY;
        m.status = Status.Open;
        m.creator = provider;
        m.feeBps = feeBps;

        // The scarcer side is the dearer one, so a high YES price means the
        // pool holds few YES. Whichever side is larger takes the whole seed.
        uint256 yesReserve;
        uint256 noReserve;
        if (openingYesPriceBps >= 5_000) {
            noReserve = liquidity;
            yesReserve = (liquidity * (10_000 - openingYesPriceBps)) / openingYesPriceBps;
        } else {
            yesReserve = liquidity;
            noReserve = (liquidity * openingYesPriceBps) / (10_000 - openingYesPriceBps);
        }
        if (yesReserve == 0 || noReserve == 0) revert BadOpeningPrice();

        m.yesReserve = yesReserve;
        m.noReserve = noReserve;
        m.collateral = liquidity;

        // Whatever the pool did not take is the creator's own position — the
        // other half of expressing a view, and what puts their money at risk.
        uint256 yesResidual = liquidity - yesReserve;
        uint256 noResidual = liquidity - noReserve;
        yesShares[marketId][provider] = yesResidual;
        noShares[marketId][provider] = noResidual;

        // The seed is denominated 1:1 in LP shares, which fixes the scale for
        // every later deposit; `addLiquidity` mints against this.
        m.totalLpShares = liquidity;
        lpShares[marketId][provider] = liquidity;

        emit MarketCreated(marketId, uint8(asset), strikePrice, expiryTime, liquidity, provider, feeBps);
        // Also as a deposit, so nothing downstream has to treat the seed as a
        // special case — it is simply the first one.
        emit LiquidityAdded(marketId, provider, liquidity, liquidity, liquidity, yesResidual, noResidual);
    }

    /**
     * @notice Add depth to an open market without moving its price, minting LP
     *         shares in proportion to what the pool actually absorbed.
     *
     * WHY THE DEPOSITOR ENDS UP HOLDING SHARES. The price of YES is
     * `N/(Y+N)`, so it is unchanged exactly when both reserves are scaled by a
     * common factor. A deposit of `d` mints `d` YES and `d` NO — equal amounts
     * — while the pool needs them in its own ratio, so the most that can go in
     * is `f = d / max(Y, N)` of each reserve. The larger side absorbs the whole
     * deposit, the smaller takes `d·min/max`, and the difference stays with the
     * depositor as a real directional position. This is the same arithmetic as
     * opening a market away from even money, and for the same reason: you
     * cannot add one-sided depth to a two-sided book without taking a view.
     *
     * Every division floors. That is safe for the invariant in a way it is not
     * in `buy`/`sell`, because the residual is defined as the complement of
     * what went in — whatever the reserves do not take, the depositor holds:
     *
     *     (Y + addYes) + (Σ yesShares + d - addYes) == C + d
     *
     * holds for ANY `addYes <= d`. What the flooring does cost is a sub-unit
     * drift in the price, bounded by one unit on each reserve.
     */
    function addLiquidity(uint256 marketId, uint256 amount, uint256 minLpSharesOut)
        external
        returns (uint256 lpSharesMinted)
    {
        Market storage m = marketData[marketId];
        if (m.status != Status.Open) revert BadStatus();
        if (block.timestamp >= m.closeTime) revert TooLate();
        if (amount == 0) revert NoLiquidity();

        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 y = m.yesReserve;
        uint256 n = m.noReserve;
        uint256 larger = y > n ? y : n;

        uint256 addYes = (amount * y) / larger;
        uint256 addNo = (amount * n) / larger;

        // Credit the SMALLER of the two proportional contributions, so rounding
        // can only ever favour the providers already in the pool. The two agree
        // to within a unit by construction; taking the min is the sub-unit
        // choice that cannot be gamed.
        uint256 byYes = (m.totalLpShares * addYes) / y;
        uint256 byNo = (m.totalLpShares * addNo) / n;
        lpSharesMinted = byYes < byNo ? byYes : byNo;

        // A deposit too small for the pool's skew would add depth to one side
        // only, moving the price — the same condition that mints nothing.
        if (lpSharesMinted == 0) revert NoLiquidity();
        if (lpSharesMinted < minLpSharesOut) revert SlippageTooHigh();

        m.yesReserve = y + addYes;
        m.noReserve = n + addNo;
        m.collateral += amount;

        uint256 yesResidual = amount - addYes;
        uint256 noResidual = amount - addNo;
        yesShares[marketId][msg.sender] += yesResidual;
        noShares[marketId][msg.sender] += noResidual;

        lpShares[marketId][msg.sender] += lpSharesMinted;
        m.totalLpShares += lpSharesMinted;

        emit LiquidityAdded(
            marketId, msg.sender, amount, lpSharesMinted, m.totalLpShares, yesResidual, noResidual
        );
    }

    /**
     * @notice What `amount` would mint right now, and the position it would
     *         leave the depositor holding.
     *
     * The residual is the surprising half of providing liquidity here, and it
     * is invisible unless the caller is told — so it is quoted alongside the
     * shares rather than left to be discovered after the fact.
     */
    function quoteAddLiquidity(uint256 marketId, uint256 amount)
        external
        view
        returns (uint256 lpSharesMinted, uint256 yesResidual, uint256 noResidual)
    {
        Market storage m = marketData[marketId];
        if (amount == 0) return (0, 0, 0);

        uint256 y = m.yesReserve;
        uint256 n = m.noReserve;
        if (y == 0 || n == 0) return (0, 0, 0);

        uint256 larger = y > n ? y : n;
        uint256 addYes = (amount * y) / larger;
        uint256 addNo = (amount * n) / larger;

        uint256 byYes = (m.totalLpShares * addYes) / y;
        uint256 byNo = (m.totalLpShares * addNo) / n;
        lpSharesMinted = byYes < byNo ? byYes : byNo;

        yesResidual = amount - addYes;
        noResidual = amount - addNo;
    }

    // --- trading -----------------------------------------------------------

    /**
     * @notice Buy `isYes` shares with `collateralIn`, reverting if fewer than
     *         `minSharesOut` come back.
     *
     * Slippage protection is a required argument rather than an option: the
     * price moves with the size of the trade itself, so a caller who does not
     * state a bound has not been asked to think about one.
     */
    function buy(uint256 marketId, bool isYes, uint256 collateralIn, uint256 minSharesOut)
        external
        returns (uint256 sharesOut)
    {
        Market storage m = marketData[marketId];
        if (m.status != Status.Open) revert BadStatus();
        if (block.timestamp >= m.closeTime) revert TooLate();
        if (collateralIn == 0) revert NoLiquidity();

        token.safeTransferFrom(msg.sender, address(this), collateralIn);

        uint256 fee;
        uint256 yesAfter;
        uint256 noAfter;
        (sharesOut, fee, yesAfter, noAfter) =
            _buyShares(m.yesReserve, m.noReserve, collateralIn, m.feeBps, isYes);

        if (sharesOut < minSharesOut) revert SlippageTooHigh();

        // The FULL amount is minted into complete sets; the fee is simply left
        // sitting in both reserves rather than moved somewhere to be accounted
        // for separately.
        m.collateral += collateralIn;
        m.yesReserve = yesAfter;
        m.noReserve = noAfter;

        if (isYes) {
            yesShares[marketId][msg.sender] += sharesOut;
        } else {
            noShares[marketId][msg.sender] += sharesOut;
        }

        emit Bought(marketId, msg.sender, isYes, collateralIn, sharesOut, fee);
    }

    /**
     * @notice Marginal price of YES, in basis points (10000 = certainty).
     *
     * In a constant-product book the marginal price of an outcome is the
     * OPPOSITE reserve over the total: the scarcer YES is in the pool, the
     * more it costs. This is the number the UI shows as an implied
     * probability, and unlike a parimutuel pool ratio it is also the price a
     * small trade actually executes at.
     */
    function yesPriceBps(uint256 marketId) external view returns (uint256) {
        Market storage m = marketData[marketId];
        uint256 total = m.yesReserve + m.noReserve;
        if (total == 0) return 5_000;
        return (m.noReserve * 10_000) / total;
    }

    /**
     * @notice Shares `collateralIn` would buy right now, without trading, and
     *         the fee included in that price.
     *
     * Routed through the same `_buyShares` as `buy` itself. The UI turns this
     * into a hard slippage bound, so a quote that computed the fee even one
     * rounding step differently would show up as trades that fail for no
     * visible reason — or, worse, be absorbed silently inside the bound.
     */
    function quote(uint256 marketId, bool isYes, uint256 collateralIn)
        external
        view
        returns (uint256 sharesOut, uint256 fee)
    {
        Market storage m = marketData[marketId];
        if (collateralIn == 0) return (0, 0);
        (sharesOut, fee,,) = _buyShares(m.yesReserve, m.noReserve, collateralIn, m.feeBps, isYes);
    }

    /**
     * @notice Sell `sharesIn` shares back to the pool for collateral, reverting
     *         below `minCollateralOut`.
     *
     * The exit that makes a locked price mean something. Without it you can
     * enter a position and then only wait — which is a bet with extra steps,
     * not a market.
     *
     * A sale is the mirror of a buy: the shares go back into the pool, and
     * enough COMPLETE SETS are then burned to restore the constant product.
     * Burning sets is what returns collateral, and it removes one share from
     * *each* side, which is why both reserves fall by the payout.
     *
     * Solving `(Y + s - c)(N - c) = k` for the payout `c` gives
     *
     *     c = [ (Y + N + s) - sqrt( (Y + N + s)^2 - 4·s·N ) ] / 2
     *
     * with the OPPOSITE reserve inside the discriminant — `N` when selling
     * YES, `Y` when selling NO.
     *
     * THE ROUNDING DIRECTION IS THE WHOLE GAME. `sqrt` must be rounded UP, so
     * that `c` comes out rounded down and any error is left in the pool. The
     * first version of this used a floored square root, which inverted that:
     * checked numerically before any of it was written, the product SHRANK on
     * every single trade — the pool paying out slightly more than it should,
     * every time, until it could not pay at all.
     */
    function sell(uint256 marketId, bool isYes, uint256 sharesIn, uint256 minCollateralOut)
        external
        returns (uint256 collateralOut)
    {
        Market storage m = marketData[marketId];
        if (m.status != Status.Open) revert BadStatus();
        if (block.timestamp >= m.closeTime) revert TooLate();
        if (sharesIn == 0) revert NoLiquidity();

        mapping(address => uint256) storage held = isYes ? yesShares[marketId] : noShares[marketId];
        if (held[msg.sender] < sharesIn) revert NotEnoughShares();

        uint256 k = m.yesReserve * m.noReserve;
        uint256 fee;
        (collateralOut, fee) = _sellProceeds(m.yesReserve, m.noReserve, sharesIn, m.feeBps, isYes);
        if (collateralOut < minCollateralOut) revert SlippageTooHigh();
        if (collateralOut == 0) revert SlippageTooHigh();

        // Only the NET leaves, so only the net is burned — the fee stays behind
        // as complete sets, which is what leaves both reserves deeper than the
        // fee-free case would.
        uint256 yesAfter = m.yesReserve + (isYes ? sharesIn : 0) - collateralOut;
        uint256 noAfter = m.noReserve + (isYes ? 0 : sharesIn) - collateralOut;

        // Belt and braces on top of the rounding: the pool may only ever come
        // out at least as deep as it went in. Cheap, and it turns a subtle
        // arithmetic slip into a revert rather than a slow drain.
        if (yesAfter * noAfter < k) revert SlippageTooHigh();

        held[msg.sender] -= sharesIn;
        m.yesReserve = yesAfter;
        m.noReserve = noAfter;
        m.collateral -= collateralOut;

        token.safeTransfer(msg.sender, collateralOut);
        emit Sold(marketId, msg.sender, isYes, sharesIn, collateralOut, fee);
    }

    /// @notice Collateral `sharesIn` would fetch right now, net of the fee,
    ///         computed by the same helper `sell` uses.
    function quoteSell(uint256 marketId, bool isYes, uint256 sharesIn)
        external
        view
        returns (uint256 collateralOut, uint256 fee)
    {
        Market storage m = marketData[marketId];
        if (sharesIn == 0) return (0, 0);
        (collateralOut, fee) = _sellProceeds(m.yesReserve, m.noReserve, sharesIn, m.feeBps, isYes);
    }

    // --- settlement --------------------------------------------------------

    function requestSettlement(uint256 marketId) external virtual {
        Market storage m = marketData[marketId];
        if (m.status != Status.Open) revert BadStatus();
        if (block.timestamp < m.settleAfter) revert TooEarly();
        m.status = Status.SettlementRequested;
        emit SettlementRequested(marketId, uint8(m.asset), m.strikePrice, m.expiryTime);
    }

    /**
     * @param report abi.encode(uint256 marketId, uint8 outcome, int256 observedValue, bytes32 evidenceHash)
     *
     * Same envelope as every other market in this project, so one workflow
     * handler serves them all.
     */
    function _processReport(bytes calldata report) internal virtual override {
        (uint256 marketId, uint8 rawOutcome, int256 observedValue, bytes32 evidenceHash) =
            abi.decode(report, (uint256, uint8, int256, bytes32));

        Market storage m = marketData[marketId];
        if (m.status != Status.SettlementRequested) revert BadStatus();

        Outcome o = Outcome(rawOutcome);
        m.outcome = o;
        m.observedValue = observedValue;
        m.evidenceHash = evidenceHash;
        // Unlike the parimutuel contracts there is no one-sided-book case to
        // rescue: every share is individually collateralised, so a market with
        // no trades at all still settles correctly — the maker simply gets
        // their liquidity back.
        m.status = o == Outcome.Void ? Status.Void : Status.Settled;

        emit Settled(marketId, o, observedValue, evidenceHash);
    }

    // --- redemption --------------------------------------------------------

    /**
     * @notice Redeem winning shares, one collateral unit each.
     *
     * A VOID PAYS HALF A UNIT PER SHARE, EITHER SIDE — not a full unit each.
     * The first version of this paid both sides in full, which is insolvent
     * on its face: one unit of collateral mints one YES *and* one NO, so
     * honouring both at par promises two units for every one held. A fuzz test
     * over Yes/No outcomes could not see it, because it only ever paid one
     * side; the void case had to be fuzzed for it to surface.
     *
     * Half each is the only split that both preserves the invariant
     * (0.5 * yes + 0.5 * no == collateral) and treats the two sides alike when
     * the question has no answer. It is NOT a refund: someone who bought YES
     * at 70 cents gets 50 back, and the difference is not recoverable from
     * share balances, which do not record what anyone paid. A void is a real
     * loss for whoever traded away from even odds, and that is a property of
     * pricing rather than a fault in the accounting.
     */
    function redeem(uint256 marketId) external {
        Market storage m = marketData[marketId];
        if (m.status != Status.Settled && m.status != Status.Void) revert BadStatus();
        if (redeemed[marketId][msg.sender]) revert AlreadyRedeemed();

        uint256 amount;
        if (m.status == Status.Void) {
            amount = (yesShares[marketId][msg.sender] + noShares[marketId][msg.sender]) / 2;
        } else if (m.outcome == Outcome.Yes) {
            amount = yesShares[marketId][msg.sender];
        } else {
            amount = noShares[marketId][msg.sender];
        }

        if (amount == 0) revert NothingToRedeem();
        redeemed[marketId][msg.sender] = true;
        token.safeTransfer(msg.sender, amount);
        emit Redeemed(marketId, msg.sender, amount);
    }

    /**
     * @notice A provider takes their share of whatever of the winning side the
     *         pool still holds — their liquidity plus or minus how the market
     *         moved against them, plus the fees it earned along the way.
     *
     * This is where a provider's risk lands. If traders bought the side that
     * won, the pool is left holding mostly the losing side and the providers
     * recover less than they put in; that shortfall is exactly what funded the
     * traders' profit. It is a bounded loss — never more than the liquidity
     * supplied — and it is the cost of quoting a price at all.
     *
     * THE DIVISION FLOORS, and that is load-bearing. For any split of the
     * providers, `Σ floor(W·sᵢ/S) <= W`, so the contract can never be asked for
     * more than the reserve holds; what rounding strands is at most one unit
     * per provider. Rounding the other way would be insolvent by a unit at a
     * time, which is exactly the shape of failure that does not show up until
     * the last claimant.
     *
     * The reserves are deliberately NOT zeroed: past settlement no path moves
     * them, so every provider computes against the same frozen snapshot, and
     * the settled market still reads honestly afterwards.
     */
    function withdrawLiquidity(uint256 marketId) external returns (uint256 amount) {
        Market storage m = marketData[marketId];
        if (m.status != Status.Settled && m.status != Status.Void) revert BadStatus();

        uint256 shares = lpShares[marketId][msg.sender];
        if (shares == 0) revert NotAnLp();
        if (lpWithdrawn[marketId][msg.sender]) revert AlreadyWithdrawn();

        amount = _lpClaim(m, shares);
        if (amount == 0) revert NothingToRedeem();

        lpWithdrawn[marketId][msg.sender] = true;
        token.safeTransfer(msg.sender, amount);
        emit LiquidityWithdrawn(marketId, msg.sender, shares, amount);
    }

    // --- views -------------------------------------------------------------

    function terms(uint256 marketId)
        external
        view
        returns (
            string memory question,
            uint8 asset,
            uint64 strikePrice,
            uint64 closeTime,
            uint64 expiryTime,
            uint64 settleAfter
        )
    {
        Market storage m = marketData[marketId];
        return (m.question, uint8(m.asset), m.strikePrice, m.closeTime, m.expiryTime, m.settleAfter);
    }

    /**
     * @notice The pool as a named struct.
     *
     * Named `poolState` rather than `pool`, and returning a struct rather than
     * a tuple, both for the same reason: the previous shape was decoded by
     * position off-chain, so a reader left on the old layout would have read
     * the wrong field with no error anywhere at all. A renamed function makes
     * a stale caller revert on an unknown selector instead, and a named struct
     * removes the class of bug for good.
     */
    function poolState(uint256 marketId) external view returns (PoolView memory) {
        Market storage m = marketData[marketId];
        return PoolView({
            status: uint8(m.status),
            outcome: uint8(m.outcome),
            observedValue: m.observedValue,
            evidenceHash: m.evidenceHash,
            yesReserve: m.yesReserve,
            noReserve: m.noReserve,
            collateral: m.collateral,
            totalLpShares: m.totalLpShares,
            feeBps: m.feeBps,
            creator: m.creator
        });
    }

    /**
     * @notice One provider's stake in a market, and what it would pay out.
     *
     * `claimable` runs through the same `_lpClaim` as `withdrawLiquidity`, so
     * the UI never has an arithmetic of its own to drift from the chain's. It
     * reads 0 before settlement — there is nothing to claim yet — and stays
     * populated after a withdrawal, with `withdrawn` telling the two apart.
     */
    function lpPosition(uint256 marketId, address who)
        external
        view
        returns (uint256 shares, uint256 totalShares, bool withdrawn, uint256 claimable)
    {
        Market storage m = marketData[marketId];
        shares = lpShares[marketId][who];
        totalShares = m.totalLpShares;
        withdrawn = lpWithdrawn[marketId][who];
        claimable = (m.status == Status.Settled || m.status == Status.Void)
            ? _lpClaim(m, shares)
            : 0;
    }

    // --- internals ---------------------------------------------------------

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /**
     * A provider's pro-rata slice of the winning reserve. Both divisions floor,
     * so the sum over all providers can only fall short of the reserve, never
     * exceed it. Shared by `withdrawLiquidity` and `lpPosition` so the quoted
     * number is the paid number by construction.
     */
    function _lpClaim(Market storage m, uint256 shares) private view returns (uint256) {
        if (shares == 0 || m.totalLpShares == 0) return 0;

        uint256 winning;
        if (m.status == Status.Void) {
            winning = (m.yesReserve + m.noReserve) / 2;
        } else if (m.outcome == Outcome.Yes) {
            winning = m.yesReserve;
        } else {
            winning = m.noReserve;
        }

        return (winning * shares) / m.totalLpShares;
    }

    /**
     * Shares a buy yields and the reserves it leaves behind, fee included.
     *
     * The fee is taken off the amount that gets SWAPPED, but the full amount is
     * still minted into complete sets — so the difference stays in the pool as
     * one YES and one NO per unit, raising both reserves. That keeps
     * `yesAfter + sharesOut == y + collateralIn` (and the same for NO), which
     * is the collateralisation invariant, while strictly growing the product:
     * both factors end up larger than the fee-free case, which was already at
     * or above `k` thanks to the ceiling division.
     */
    function _buyShares(uint256 y, uint256 n, uint256 collateralIn, uint16 feeBps, bool isYes)
        private
        pure
        returns (uint256 sharesOut, uint256 fee, uint256 yesAfter, uint256 noAfter)
    {
        fee = _ceilDiv(collateralIn * feeBps, 10_000);
        uint256 net = collateralIn - fee;
        uint256 k = y * n;

        if (isYes) {
            // Ceiling division keeps the product at or above k, so rounding
            // can only ever favour the pool — never the buyer.
            uint256 remaining = _ceilDiv(k, n + net);
            sharesOut = (y + net) - remaining;
            yesAfter = remaining + fee;
            noAfter = n + net + fee;
        } else {
            uint256 remaining = _ceilDiv(k, y + net);
            sharesOut = (n + net) - remaining;
            noAfter = remaining + fee;
            yesAfter = y + net + fee;
        }
    }

    /**
     * What a sale pays out, net of the fee, and the fee itself.
     *
     * The fee is charged on the gross payout and simply not paid out, so the
     * reserves are burned down by the net only and end up deeper by exactly the
     * fee than the fee-free case — which is what makes the product grow rather
     * than merely hold.
     */
    function _sellProceeds(uint256 y, uint256 n, uint256 sharesIn, uint16 feeBps, bool isYes)
        private
        pure
        returns (uint256 collateralOut, uint256 fee)
    {
        uint256 gross = _sellPayout(y, n, sharesIn, isYes);
        fee = _ceilDiv(gross * feeBps, 10_000);
        collateralOut = gross - fee;
    }

    /// Closed-form sale payout; see `sell` for the derivation and the rounding.
    function _sellPayout(uint256 yesReserve, uint256 noReserve, uint256 sharesIn, bool isYes)
        private
        pure
        returns (uint256)
    {
        uint256 total = yesReserve + noReserve + sharesIn;
        uint256 opposite = isYes ? noReserve : yesReserve;
        uint256 discriminant = total * total - 4 * sharesIn * opposite;

        // Rounded UP, so the payout below rounds down and the pool keeps the
        // remainder. Rounding this the other way drains the pool on every sale.
        uint256 root = Math.sqrt(discriminant);
        if (root * root < discriminant) root += 1;

        return total <= root ? 0 : (total - root) / 2;
    }
}
