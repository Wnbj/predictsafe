// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/**
 * Asks for settlement on markets whose time has come, so nobody has to press
 * the button.
 *
 * Every market contract already lets ANYONE call `requestSettlement` once
 * `settleAfter` has passed, and the DON settles from the event that call
 * emits. What was missing was someone to make the call. A DON report cannot be
 * that someone directly — the forwarder delivers reports to `onReport`, and the
 * market contracts accept a report only for a market already in
 * SettlementRequested. So the DON reports here, and this contract makes the
 * public call on its behalf.
 *
 * It holds no money and gains no power by being the caller: whatever it can do,
 * any wallet could do. The one thing it adds is a per-contract `delay` on top
 * of `settleAfter`, enforced here rather than in the workflow so a report
 * cannot get around it. Flights need it — a flight still in the air at
 * settlement voids its market, and a long delay is exactly when a Yes should
 * win — so they are requested hours after a person could have pressed the
 * button, not the minute they could.
 *
 * Which markets are due is answered by `dueMarkets`, a view, so the workflow
 * spends one chain read on it rather than one per market against a budget of
 * fifteen. `_processReport` checks every id again at execution: reads are
 * pinned to the finalized block, so the workflow can name a market that was
 * requested minutes ago, and that must be a quiet skip, not a revert that takes
 * the rest of the batch with it.
 */
contract SettlementKeeper is ReceiverTemplate {
    /// How each kind of market contract exposes its status and settleAfter.
    enum Kind {
        Parimutuel, // CryptoMarket, StockMarket, ReserveMarket: core(id)
        Flight,     // FlightMarket: markets(id)
        Amm         // AmmMarket: terms(id) + poolState(id); no Locked state
    }

    struct Watched {
        address market;
        Kind kind;
        /// Seconds after settleAfter before this keeper will ask.
        uint32 delay;
    }

    /// Newest markets examined per contract. Anything older that is still
    /// open is weeks stale and is left to a person.
    uint256 public constant SCAN_BACK = 40;

    Watched[] internal watched;
    mapping(address => uint256) internal slotPlusOne;

    event MarketContractWatched(address indexed market, Kind kind, uint32 delay);
    event MarketContractUnwatched(address indexed market);
    event SettlementRequestSent(address indexed market, uint256 indexed marketId);
    event SettlementRequestSkipped(address indexed market, uint256 indexed marketId, bytes reason);

    error LengthMismatch();

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    // --- configuration ------------------------------------------------------

    /// Adds a market contract, or updates its kind and delay.
    function watch(address market, Kind kind, uint32 delay) external onlyOwner {
        uint256 slot = slotPlusOne[market];
        if (slot == 0) {
            watched.push(Watched(market, kind, delay));
            slotPlusOne[market] = watched.length;
        } else {
            watched[slot - 1] = Watched(market, kind, delay);
        }
        emit MarketContractWatched(market, kind, delay);
    }

    function unwatch(address market) external onlyOwner {
        uint256 slot = slotPlusOne[market];
        if (slot == 0) return;
        Watched memory last = watched[watched.length - 1];
        watched[slot - 1] = last;
        slotPlusOne[last.market] = slot;
        watched.pop();
        delete slotPlusOne[market];
        emit MarketContractUnwatched(market);
    }

    function watchedCount() external view returns (uint256) {
        return watched.length;
    }

    function watchedAt(uint256 i) external view returns (address market, Kind kind, uint32 delay) {
        Watched memory w = watched[i];
        return (w.market, w.kind, w.delay);
    }

    // --- reads --------------------------------------------------------------

    /// Whether this keeper would ask for settlement on `marketId` right now.
    function isDue(address market, uint256 marketId) public view returns (bool) {
        uint256 slot = slotPlusOne[market];
        if (slot == 0) return false;
        return _isDue(watched[slot - 1], marketId);
    }

    /**
     * Up to `max` markets due for a settlement request, newest first within
     * each contract, as parallel arrays.
     */
    function dueMarkets(uint256 max) external view returns (address[] memory markets, uint256[] memory ids) {
        markets = new address[](max);
        ids = new uint256[](max);
        uint256 n;
        for (uint256 w; w < watched.length && n < max; w++) {
            Watched memory c = watched[w];
            uint256 count = IMarketCount(c.market).marketCount();
            uint256 stop = count > SCAN_BACK ? count - SCAN_BACK : 0;
            for (uint256 id = count; id > stop && n < max; id--) {
                if (_isDue(c, id - 1)) {
                    markets[n] = c.market;
                    ids[n] = id - 1;
                    n++;
                }
            }
        }
        assembly {
            mstore(markets, n)
            mstore(ids, n)
        }
    }

    function _isDue(Watched memory c, uint256 marketId) internal view returns (bool) {
        (bool requestable, uint64 settleAfter) = _state(c, marketId);
        return requestable && block.timestamp >= uint256(settleAfter) + c.delay;
    }

    /// Whether the market can still be requested, and when it first could.
    function _state(Watched memory c, uint256 marketId) internal view returns (bool, uint64) {
        if (c.kind == Kind.Parimutuel) {
            (, , uint64 settleAfter, uint8 status, , , , , ) = IParimutuelCore(c.market).core(marketId);
            return (status == 0 || status == 1, settleAfter); // Open, Locked
        }
        if (c.kind == Kind.Flight) {
            (, , , , , uint64 settleAfter, uint8 status, , , , , ) = IFlightMarkets(c.market).markets(marketId);
            return (status == 0 || status == 1, settleAfter); // Open, Locked
        }
        (, , , , , uint64 ammSettleAfter) = IAmmViews(c.market).terms(marketId);
        return (IAmmViews(c.market).poolState(marketId).status == 0, ammSettleAfter); // Open only
    }

    // --- the report ---------------------------------------------------------

    /// `abi.encode(address[] markets, uint256[] ids)`, as `dueMarkets` returns them.
    function _processReport(bytes calldata report) internal override {
        (address[] memory markets, uint256[] memory ids) = abi.decode(report, (address[], uint256[]));
        if (markets.length != ids.length) revert LengthMismatch();

        for (uint256 i; i < ids.length; i++) {
            if (!isDue(markets[i], ids[i])) {
                emit SettlementRequestSkipped(markets[i], ids[i], "not due");
                continue;
            }
            try ISettleable(markets[i]).requestSettlement(ids[i]) {
                emit SettlementRequestSent(markets[i], ids[i]);
            } catch (bytes memory reason) {
                emit SettlementRequestSkipped(markets[i], ids[i], reason);
            }
        }
    }
}

interface ISettleable {
    function requestSettlement(uint256 marketId) external;
}

interface IMarketCount {
    function marketCount() external view returns (uint256);
}

interface IParimutuelCore {
    function core(uint256 marketId)
        external
        view
        returns (string memory, uint64, uint64, uint8, uint8, bytes32, int256, uint256, uint256);
}

interface IFlightMarkets {
    function markets(uint256 marketId)
        external
        view
        returns (
            string memory, string memory, uint32, uint16, uint64, uint64,
            uint8, uint8, bytes32, int32, uint256, uint256
        );
}

interface IAmmViews {
    struct PoolView {
        uint8 status;
        uint8 outcome;
        int256 observedValue;
        bytes32 evidenceHash;
        uint256 yesReserve;
        uint256 noReserve;
        uint256 collateral;
        uint256 totalLpShares;
        uint16 feeBps;
        address creator;
    }

    function terms(uint256 marketId)
        external
        view
        returns (string memory, uint8, uint64, uint64, uint64, uint64);

    function poolState(uint256 marketId) external view returns (PoolView memory);
}
