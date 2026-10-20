// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/**
 * Opens markets on a schedule, in every category, so the board is never empty.
 *
 * Every market contract's `newMarket` is open to anyone, so this contract gains
 * nothing by being the caller: it exists because a DON report cannot make the
 * call directly — reports go to `onReport` — exactly as SettlementKeeper exists
 * to make `requestSettlement`. The workflow decides what to open (a BTC market
 * every hour, gold every four hours on weekdays, tomorrow's BA286, …), reads
 * strikes from Chainlink Data Feeds, and reports the terms; this contract opens
 * them on the right contract.
 *
 * A spec names its KIND and carries that kind's terms ABI-encoded, so one
 * report can open markets on several contracts:
 *
 *   Crypto   (uint8 asset, uint64 strike)                         on CryptoMarket
 *   Stock    (uint64 strike, uint32 maxStaleness), id = symbol     on StockMarket
 *   Reserve  (uint64 strike, uint32 maxStaleness), id = symbol     on ReserveMarket
 *   Flight   (uint32 departureDate, uint16 thresholdMinutes), id = flight number,
 *            expiryTime = settleAfter                              on FlightMarket
 *   Amm      (uint8 asset, uint64 strike, uint256 liquidity,
 *             uint256 openingYesPriceBps, uint16 feeBps)           on AmmMarket
 *
 * An AMM market needs liquidity from its opener. This contract mints it from
 * MockUSDC, whose mint is open — test money — and is the market's provider.
 *
 * What a report can do is bounded HERE, not in the workflow:
 *
 *  - each slot — kind, close, expiry, id — opens at most once: the workflow
 *    reads at the finalized block, so it can name what the last run opened;
 *  - staking must stay open at least MIN_OPEN after the market appears;
 *  - expiry (settleAfter, for a flight) no further out than MAX_HORIZON;
 *  - a sensible question and id, and AMM liquidity within bounds.
 *
 * A spec that fails these, or that the market contract refuses — including
 * terms that do not decode — is skipped with a reason rather than reverting
 * the batch: each one opens through an external self-call so even a decode
 * failure is caught.
 */
contract MarketScheduler is ReceiverTemplate {
    enum Kind {
        Crypto,
        Stock,
        Reserve,
        Flight,
        Amm
    }

    struct Spec {
        uint8 kind;
        uint64 closeTime;
        uint64 expiryTime;
        /// What the slot is about: "BTC", "CSPX", "BA286".
        string id;
        string question;
        bytes terms;
    }

    struct Targets {
        address crypto;
        address stock;
        address reserve;
        address flight;
        address amm;
        address usdc;
    }

    uint64 public constant MIN_OPEN = 5 minutes;
    uint64 public constant MAX_HORIZON = 4 days;
    uint256 public constant MAX_QUESTION = 160;
    uint256 public constant MAX_ID = 16;
    uint256 public constant MAX_SPECS = 6;
    uint256 public constant MAX_AMM_LIQUIDITY = 100e6;

    address public immutable crypto;
    address public immutable stock;
    address public immutable reserve;
    address public immutable flight;
    address public immutable amm;
    address public immutable usdc;

    mapping(bytes32 => uint256) internal _marketIdPlusOne;

    event MarketScheduled(bytes32 indexed key, uint8 indexed kind, uint256 marketId, string id, uint64 closeTime, uint64 expiryTime);
    event MarketScheduleSkipped(bytes32 indexed key, uint8 indexed kind, string id, bytes reason);

    error TooManySpecs();
    error OnlySelf();
    error LengthMismatch();
    error TooMuchLiquidity();

    constructor(address forwarder, Targets memory t) ReceiverTemplate(forwarder) {
        crypto = t.crypto;
        stock = t.stock;
        reserve = t.reserve;
        flight = t.flight;
        amm = t.amm;
        usdc = t.usdc;
    }

    function slotKey(uint8 kind, uint64 closeTime, uint64 expiryTime, string memory id) public pure returns (bytes32) {
        return keccak256(abi.encode(kind, closeTime, expiryTime, id));
    }

    /// Whether each slot has been opened — one read for a whole run's candidates.
    function scheduledMany(bytes32[] calldata keys) external view returns (bool[] memory open) {
        open = new bool[](keys.length);
        for (uint256 i; i < keys.length; i++) open[i] = _marketIdPlusOne[keys[i]] != 0;
    }

    /// The market a slot became, if it has been opened.
    function scheduled(bytes32 key) external view returns (bool exists, uint256 marketId) {
        uint256 v = _marketIdPlusOne[key];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    /**
     * Records slots opened by an earlier scheduler, so moving to this one does
     * not open them a second time. Owner-only, and it opens nothing.
     */
    function adopt(bytes32[] calldata keys, uint256[] calldata marketIds) external onlyOwner {
        if (keys.length != marketIds.length) revert LengthMismatch();
        for (uint256 i; i < keys.length; i++) _marketIdPlusOne[keys[i]] = marketIds[i] + 1;
    }

    /// `abi.encode(Spec[])`.
    function _processReport(bytes calldata report) internal override {
        Spec[] memory specs = abi.decode(report, (Spec[]));
        if (specs.length > MAX_SPECS) revert TooManySpecs();

        for (uint256 i; i < specs.length; i++) {
            Spec memory s = specs[i];
            bytes32 key = slotKey(s.kind, s.closeTime, s.expiryTime, s.id);
            bytes memory why = _invalid(s, key);
            if (why.length != 0) {
                emit MarketScheduleSkipped(key, s.kind, s.id, why);
                continue;
            }
            try this.openOne(s) returns (uint256 marketId) {
                _marketIdPlusOne[key] = marketId + 1;
                emit MarketScheduled(key, s.kind, marketId, s.id, s.closeTime, s.expiryTime);
            } catch (bytes memory reason) {
                emit MarketScheduleSkipped(key, s.kind, s.id, reason);
            }
        }
    }

    /// Opens one spec on its contract. External only so `_processReport` can catch anything it throws.
    function openOne(Spec calldata s) external returns (uint256) {
        if (msg.sender != address(this)) revert OnlySelf();
        Kind kind = Kind(s.kind);

        if (kind == Kind.Crypto) {
            (uint8 asset, uint64 strike) = abi.decode(s.terms, (uint8, uint64));
            return ICryptoMarketCreate(crypto).newMarket(s.question, asset, strike, s.closeTime, s.expiryTime);
        }
        if (kind == Kind.Stock || kind == Kind.Reserve) {
            (uint64 strike, uint32 maxStaleness) = abi.decode(s.terms, (uint64, uint32));
            return IFeedMarketCreate(kind == Kind.Stock ? stock : reserve).newMarket(
                s.question, s.id, strike, s.closeTime, s.expiryTime, maxStaleness
            );
        }
        if (kind == Kind.Flight) {
            (uint32 departureDate, uint16 threshold) = abi.decode(s.terms, (uint32, uint16));
            return IFlightMarketCreate(flight).newMarket(s.question, s.id, departureDate, threshold, s.closeTime, s.expiryTime);
        }
        (uint8 ammAsset, uint64 ammStrike, uint256 liquidity, uint256 openingBps, uint16 feeBps) =
            abi.decode(s.terms, (uint8, uint64, uint256, uint256, uint16));
        if (liquidity > MAX_AMM_LIQUIDITY) revert TooMuchLiquidity();
        IMintable(usdc).mint(address(this), liquidity);
        IERC20(usdc).approve(amm, liquidity);
        return IAmmMarketCreate(amm).newMarket(
            s.question, ammAsset, ammStrike, s.closeTime, s.expiryTime, liquidity, openingBps, feeBps
        );
    }

    function _invalid(Spec memory s, bytes32 key) internal view returns (bytes memory) {
        if (_marketIdPlusOne[key] != 0) return "already open";
        if (s.kind > uint8(Kind.Amm)) return "unknown kind";
        if (_target(Kind(s.kind)) == address(0)) return "no contract for kind";
        if (s.closeTime > s.expiryTime) return "closes after expiry";
        if (s.closeTime < block.timestamp + MIN_OPEN) return "too late to stake";
        if (s.expiryTime > block.timestamp + MAX_HORIZON) return "too far out";
        uint256 q = bytes(s.question).length;
        if (q == 0 || q > MAX_QUESTION) return "bad question";
        uint256 n = bytes(s.id).length;
        if (n == 0 || n > MAX_ID) return "bad id";
        return "";
    }

    function _target(Kind kind) internal view returns (address) {
        if (kind == Kind.Crypto) return crypto;
        if (kind == Kind.Stock) return stock;
        if (kind == Kind.Reserve) return reserve;
        if (kind == Kind.Flight) return flight;
        return amm;
    }
}

interface ICryptoMarketCreate {
    function newMarket(string calldata question, uint8 asset, uint64 strikePrice, uint64 closeTime, uint64 expiryTime)
        external
        returns (uint256 marketId);
}

interface IFeedMarketCreate {
    function newMarket(
        string calldata question,
        string calldata symbol,
        uint64 strikePrice,
        uint64 closeTime,
        uint64 expiryTime,
        uint32 maxStaleness
    ) external returns (uint256 marketId);
}

interface IFlightMarketCreate {
    function newMarket(
        string calldata question,
        string calldata flightIata,
        uint32 departureDate,
        uint16 thresholdMinutes,
        uint64 closeTime,
        uint64 settleAfter
    ) external returns (uint256 marketId);
}

interface IAmmMarketCreate {
    function newMarket(
        string calldata question,
        uint8 asset,
        uint64 strikePrice,
        uint64 closeTime,
        uint64 expiryTime,
        uint256 liquidity,
        uint256 openingYesPriceBps,
        uint16 feeBps
    ) external returns (uint256 marketId);
}

interface IMintable {
    function mint(address to, uint256 amount) external;
}
