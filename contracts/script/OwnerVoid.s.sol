// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AmmMarket} from "../src/AmmMarket.sol";
import {SportsMarket} from "../src/SportsMarket.sol";

/**
 * The escape hatch for AMM and football markets: void one whose settlement
 * will not come — the DON stopped, a venue vanished — so its money can be
 * redeemed at half a unit per share, as every void pays.
 *
 * The parimutuel contracts have `ownerVoid`; these two do not, and do not need
 * a redeploy for it. Every receiver lets its owner name the forwarder, so the
 * owner stands in as the forwarder for one report — a VOID, signed by nobody
 * but the owner — and then hands the role straight back. Exactly the trust
 * `ownerVoid` already asks for, nothing more: the owner could always have done
 * this, and now it is written down instead of improvised.
 *
 * Three transactions, run with `--slow` so they land in order. While the
 * forwarder is the owner, a DON report to THIS contract is refused (and
 * retried by the next sweep), so check afterwards that the forwarder is back:
 *
 *     cast call $MARKET 'getForwarderAddress()(address)'
 *
 * Required env: DEPLOYER_PK (the owner), MARKET, and either
 *   KIND=amm    MARKET_ID=<id>   — an AMM market (requests settlement first if
 *                                  it is still Open and past settleAfter)
 *   KIND=sports MATCH_ID=<id>    — all three markets of a football match
 */
contract OwnerVoid is Script {
    bytes32 constant EVIDENCE = keccak256("owner void");

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address market = vm.envAddress("MARKET");
        bytes32 kind = keccak256(bytes(vm.envString("KIND")));

        vm.startBroadcast(pk);
        if (kind == keccak256("amm")) {
            voidAmmMarket(AmmMarket(market), vm.envUint("MARKET_ID"), vm.addr(pk));
        } else if (kind == keccak256("sports")) {
            voidMatch(SportsMarket(market), uint64(vm.envUint("MATCH_ID")), vm.addr(pk));
        } else {
            revert("KIND must be amm or sports");
        }
        vm.stopBroadcast();
        console2.log("forwarder restored to", AmmMarket(market).getForwarderAddress());
    }

    /// `caller` is whoever sends these calls: the owner's address on chain, this contract in a test.
    function voidAmmMarket(AmmMarket market, uint256 marketId, address caller) public {
        if (market.poolState(marketId).status == uint8(AmmMarket.Status.Open)) market.requestSettlement(marketId);
        _asForwarder(market, caller, abi.encode(marketId, uint8(AmmMarket.Outcome.Void), int256(0), EVIDENCE));
    }

    function voidMatch(SportsMarket sports, uint64 matchId, address caller) public {
        SportsMarket.MatchResult[] memory results = new SportsMarket.MatchResult[](1);
        results[0] = SportsMarket.MatchResult({matchId: matchId, result: sports.VOID(), evidenceHash: EVIDENCE});
        _asForwarder(sports, caller, abi.encode(new SportsMarket.MatchSpec[](0), results));
    }

    function _asForwarder(AmmMarket market, address caller, bytes memory report) internal {
        address forwarder = market.getForwarderAddress();
        // The identity checks still run, so the metadata names the workflow the
        // contract expects. Nothing else reads it.
        bytes memory meta =
            abi.encodePacked(bytes32(0), market.getExpectedWorkflowName(), market.getExpectedAuthor());
        market.setForwarderAddress(caller);
        market.onReport(meta, report);
        market.setForwarderAddress(forwarder);
    }
}
