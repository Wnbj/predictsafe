// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/**
 * Opens crypto markets on a schedule, so the board is never empty.
 *
 * `CryptoMarket.newMarket` is open to anyone and takes no collateral, so this
 * contract gains nothing by being the caller: it exists because a DON report
 * cannot make the call directly — reports go to `onReport` — exactly as
 * SettlementKeeper exists to make `requestSettlement`. The workflow reads the
 * price from a Chainlink Data Feed, picks a round strike near it, and reports
 * the market's terms here; this contract opens it.
 *
 * What a report can do is bounded HERE, not in the workflow, so a bad report
 * cannot open a market nobody could sensibly stake on:
 *
 *  - each slot (asset, close, expiry) opens at most once — the workflow reads
 *    at the finalized block, so it can name a market the previous run already
 *    opened, and that must be a quiet skip;
 *  - staking must stay open at least MIN_OPEN after the market appears;
 *  - expiry no further out than MAX_HORIZON;
 *  - a strike above zero and a question of sensible length.
 *
 * A spec that fails any of these, or that `newMarket` refuses, is skipped with
 * a reason in an event rather than reverting the batch.
 */
contract MarketScheduler is ReceiverTemplate {
    struct Spec {
        uint8 asset; // CryptoMarket.Asset: 0 BTC, 1 ETH
        uint64 strike; // 8 decimals
        uint64 closeTime;
        uint64 expiryTime;
        string question;
    }

    uint64 public constant MIN_OPEN = 5 minutes;
    uint64 public constant MAX_HORIZON = 3 days;
    uint256 public constant MAX_QUESTION = 160;
    uint256 public constant MAX_SPECS = 6;

    ICryptoMarketCreate public immutable markets;

    mapping(bytes32 => uint256) internal _marketIdPlusOne;

    event MarketScheduled(
        uint256 indexed marketId, uint8 indexed asset, uint64 strike, uint64 closeTime, uint64 expiryTime
    );
    event MarketScheduleSkipped(uint8 indexed asset, uint64 closeTime, uint64 expiryTime, bytes reason);

    error TooManySpecs();

    constructor(address forwarder, ICryptoMarketCreate _markets) ReceiverTemplate(forwarder) {
        markets = _markets;
    }

    function slotKey(uint8 asset, uint64 closeTime, uint64 expiryTime) public pure returns (bytes32) {
        return keccak256(abi.encode(asset, closeTime, expiryTime));
    }

    /// Whether this slot has been opened, and as which market.
    function scheduled(uint8 asset, uint64 closeTime, uint64 expiryTime)
        external
        view
        returns (bool exists, uint256 marketId)
    {
        uint256 v = _marketIdPlusOne[slotKey(asset, closeTime, expiryTime)];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    /// `abi.encode(Spec[])`.
    function _processReport(bytes calldata report) internal override {
        Spec[] memory specs = abi.decode(report, (Spec[]));
        if (specs.length > MAX_SPECS) revert TooManySpecs();

        for (uint256 i; i < specs.length; i++) {
            Spec memory s = specs[i];
            bytes memory why = _invalid(s);
            if (why.length != 0) {
                emit MarketScheduleSkipped(s.asset, s.closeTime, s.expiryTime, why);
                continue;
            }
            bytes32 key = slotKey(s.asset, s.closeTime, s.expiryTime);
            try markets.newMarket(s.question, s.asset, s.strike, s.closeTime, s.expiryTime) returns (uint256 id) {
                _marketIdPlusOne[key] = id + 1;
                emit MarketScheduled(id, s.asset, s.strike, s.closeTime, s.expiryTime);
            } catch (bytes memory reason) {
                emit MarketScheduleSkipped(s.asset, s.closeTime, s.expiryTime, reason);
            }
        }
    }

    function _invalid(Spec memory s) internal view returns (bytes memory) {
        if (_marketIdPlusOne[slotKey(s.asset, s.closeTime, s.expiryTime)] != 0) return "already open";
        if (s.asset > 1) return "unknown asset";
        if (s.strike == 0) return "no strike";
        if (s.closeTime > s.expiryTime) return "closes after expiry";
        if (s.closeTime < block.timestamp + MIN_OPEN) return "too late to stake";
        if (s.expiryTime > block.timestamp + MAX_HORIZON) return "too far out";
        uint256 len = bytes(s.question).length;
        if (len == 0 || len > MAX_QUESTION) return "bad question";
        return "";
    }
}

interface ICryptoMarketCreate {
    function newMarket(
        string calldata question,
        uint8 asset,
        uint64 strikePrice,
        uint64 closeTime,
        uint64 expiryTime
    ) external returns (uint256 marketId);
}
