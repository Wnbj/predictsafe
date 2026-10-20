// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AmmMarket} from "./AmmMarket.sol";

/**
 * @title SportsMarket
 * @notice Football matches as AMM markets: three per match — the home side
 *         wins, a draw, the away side wins — each an ordinary AmmMarket
 *         market, so buying, selling, redeeming and providing liquidity are
 *         exactly what the AMM category already does.
 *
 *  WHAT IS DIFFERENT IS WHO OPENS AND SETTLES THEM. A Chainlink DON does both,
 *  from football-data.org, in one report shape:
 *
 *      abi.encode(MatchSpec[] opens, MatchResult[] results)
 *
 *  - A MatchSpec opens a match: three markets, closing at kickoff, each
 *    seeded with liquidity this contract mints from MockUSDC (test money) at
 *    an opening price per outcome. The contract is their first provider.
 *  - A MatchResult settles all three at once — Yes on the outcome that
 *    happened, No on the other two — or voids all three for a match that was
 *    postponed, cancelled, or never reported.
 *
 *  THE ANSWER IS THE RESULT AFTER NINETY MINUTES. A cup tie that goes to extra
 *  time and is level at ninety is a draw here, whoever goes through: the three
 *  questions together cover every outcome exactly once only if they all ask
 *  about the same moment.
 *
 *  There is no requestSettlement step, as there is no price to read at a
 *  moment: the workflow sees the final score and reports it, no earlier than
 *  SETTLE_AFTER past kickoff. Markets cannot be opened by anyone else here —
 *  `newMarket` is shut — because a price market in this contract would have
 *  nothing to settle it.
 *
 *  Like every report path in this project, nothing a report names is trusted
 *  blindly: an unknown match, a duplicate, a result too early, a kickoff in
 *  the past is skipped with a reason in an event, never reverting the batch.
 *
 *  NOT AUDITED. POC only, on a testnet, with a freely mintable stake token.
 */
contract SportsMarket is AmmMarket {
    uint8 public constant HOME = 1;
    uint8 public constant DRAW = 2;
    uint8 public constant AWAY = 3;
    uint8 public constant VOID = 4;

    /// The earliest a result is accepted: ninety minutes, half time, stoppage.
    uint64 public constant SETTLE_AFTER = 2 hours;
    /// A match is opened at least this long before kickoff.
    uint64 public constant MIN_LEAD = 30 minutes;
    uint64 public constant MAX_LEAD = 7 days;
    uint256 public constant MAX_LIQUIDITY = 100e6;
    uint256 public constant MAX_PER_REPORT = 6;

    struct MatchSpec {
        /// football-data.org's match id.
        uint64 matchId;
        uint64 kickoff;
        string competition;
        string home;
        string away;
        /// Liquidity for EACH of the three markets, in mUSDC units.
        uint256 liquidity;
        /// Opening chance of home, draw, away, in basis points.
        uint16[3] openingBps;
        uint16 feeBps;
    }

    struct MatchResult {
        uint64 matchId;
        /// HOME, DRAW, AWAY or VOID.
        uint8 result;
        /// Hash of the normalised score the workflow agreed on.
        bytes32 evidenceHash;
    }

    struct MatchInfo {
        uint64 matchId;
        uint64 kickoff;
        string competition;
        string home;
        string away;
        /// The home-win market; draw and away are the next two ids.
        uint256 firstMarketId;
        /// 0 until settled, then HOME, DRAW, AWAY or VOID.
        uint8 result;
    }

    MatchInfo[] internal _matches;
    mapping(uint64 => uint256) internal _slotPlusOne; // matchId => index + 1
    /// Which match a market belongs to, as its index in `_matches` plus one.
    mapping(uint256 => uint256) public matchSlotOfMarket;

    event MatchOpened(uint64 indexed matchId, uint256 firstMarketId, uint64 kickoff, string home, string away);
    event MatchSettled(uint64 indexed matchId, uint8 result, bytes32 evidenceHash);
    event MatchSkipped(uint64 indexed matchId, bytes reason);

    error MatchesOnly();
    error TooManyInReport();

    constructor(IERC20 _token, address _forwarder) AmmMarket(_token, _forwarder) {}

    // --- shut: a price market here would have nothing to settle it ----------

    function newMarket(string calldata, Asset, uint64, uint64, uint64, uint256, uint256, uint16)
        external
        pure
        override
        returns (uint256)
    {
        revert MatchesOnly();
    }

    function requestSettlement(uint256) external pure override {
        revert MatchesOnly();
    }

    // --- the report -------------------------------------------------------------

    function _processReport(bytes calldata report) internal override {
        (MatchSpec[] memory opens, MatchResult[] memory results) = abi.decode(report, (MatchSpec[], MatchResult[]));
        if (opens.length + results.length > MAX_PER_REPORT) revert TooManyInReport();

        for (uint256 i; i < results.length; i++) _settleMatch(results[i]);
        for (uint256 i; i < opens.length; i++) _openMatch(opens[i]);
    }

    function _openMatch(MatchSpec memory s) internal {
        bytes memory why;
        if (_slotPlusOne[s.matchId] != 0) why = "already open";
        else if (s.kickoff < block.timestamp + MIN_LEAD) why = "too close to kickoff";
        else if (s.kickoff > block.timestamp + MAX_LEAD) why = "too far out";
        else if (s.liquidity > MAX_LIQUIDITY) why = "too much liquidity";
        else if (bytes(s.home).length == 0 || bytes(s.away).length == 0) why = "no teams";
        if (why.length != 0) {
            emit MatchSkipped(s.matchId, why);
            return;
        }

        IMintableToken(address(token)).mint(address(this), s.liquidity * 3);

        // The match id rides in strikePrice, which an AMM market requires to be
        // non-zero and which nothing here reads as a price.
        uint64 settleAt = s.kickoff + SETTLE_AFTER - SETTLEMENT_DELAY;
        uint256 first = _createMarket("", Asset.BTC, s.matchId, s.kickoff, settleAt, s.liquidity, s.openingBps[0], s.feeBps, address(this));
        _createMarket("", Asset.BTC, s.matchId, s.kickoff, settleAt, s.liquidity, s.openingBps[1], s.feeBps, address(this));
        _createMarket("", Asset.BTC, s.matchId, s.kickoff, settleAt, s.liquidity, s.openingBps[2], s.feeBps, address(this));

        _matches.push(MatchInfo({
            matchId: s.matchId,
            kickoff: s.kickoff,
            competition: s.competition,
            home: s.home,
            away: s.away,
            firstMarketId: first,
            result: 0
        }));
        uint256 slot = _matches.length;
        _slotPlusOne[s.matchId] = slot;
        matchSlotOfMarket[first] = slot;
        matchSlotOfMarket[first + 1] = slot;
        matchSlotOfMarket[first + 2] = slot;
        emit MatchOpened(s.matchId, first, s.kickoff, s.home, s.away);
    }

    function _settleMatch(MatchResult memory r) internal {
        uint256 slot = _slotPlusOne[r.matchId];
        bytes memory why;
        if (slot == 0) why = "unknown match";
        else if (_matches[slot - 1].result != 0) why = "already settled";
        else if (r.result < HOME || r.result > VOID) why = "bad result";
        else if (r.result != VOID && block.timestamp < _matches[slot - 1].kickoff + SETTLE_AFTER) why = "too early";
        if (why.length != 0) {
            emit MatchSkipped(r.matchId, why);
            return;
        }

        MatchInfo storage info = _matches[slot - 1];
        info.result = r.result;
        for (uint8 k; k < 3; k++) {
            uint256 id = info.firstMarketId + k;
            Market storage m = marketData[id];
            Outcome o = r.result == VOID ? Outcome.Void : (r.result == k + 1 ? Outcome.Yes : Outcome.No);
            m.outcome = o;
            m.observedValue = int256(uint256(r.result));
            m.evidenceHash = r.evidenceHash;
            m.status = o == Outcome.Void ? Status.Void : Status.Settled;
            emit Settled(id, o, int256(uint256(r.result)), r.evidenceHash);
        }
        emit MatchSettled(r.matchId, r.result, r.evidenceHash);
    }

    // --- views --------------------------------------------------------------------

    function matchCount() external view returns (uint256) {
        return _matches.length;
    }

    function matchAt(uint256 index) external view returns (MatchInfo memory) {
        return _matches[index];
    }

    /// The match a market belongs to, and which outcome it asks about (1 home, 2 draw, 3 away).
    function matchOf(uint256 marketId) external view returns (MatchInfo memory info, uint8 outcome) {
        uint256 slot = matchSlotOfMarket[marketId];
        if (slot == 0) return (info, 0);
        info = _matches[slot - 1];
        outcome = uint8(marketId - info.firstMarketId) + 1;
    }

    /**
     * Matches still waiting for a result, newest last — what the workflow
     * reads each run, in one call, to know what to settle and how many are
     * open. Walks back at most `max` matches.
     */
    function unsettled(uint256 max) external view returns (uint64[] memory ids, uint64[] memory kickoffs) {
        ids = new uint64[](max);
        kickoffs = new uint64[](max);
        uint256 n;
        for (uint256 i = _matches.length; i > 0 && n < max; i--) {
            MatchInfo storage m = _matches[i - 1];
            if (m.result == 0) {
                ids[n] = m.matchId;
                kickoffs[n] = m.kickoff;
                n++;
            }
        }
        assembly {
            mstore(ids, n)
            mstore(kickoffs, n)
        }
    }
}

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}
