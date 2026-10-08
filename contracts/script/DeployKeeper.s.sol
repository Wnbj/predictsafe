// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {SettlementKeeper} from "../src/SettlementKeeper.sol";

/**
 * Deploys SettlementKeeper and points it at the five market contracts.
 *
 * Required env:
 *   DEPLOYER_PK      - key to deploy and own from
 *   FORWARDER        - the KeystoneForwarder allowed to deliver reports
 *   WORKFLOW_NAME    - the workflow whose reports are accepted
 *   WORKFLOW_AUTHOR  - the owner the DON presents for that workflow
 *   FLIGHT, CRYPTO, STOCK, RESERVE, AMM - the market contracts
 * Optional env:
 *   FLIGHT_DELAY     - seconds past settleAfter before a flight is requested
 *                      (default 6 hours)
 *
 * Run it without --broadcast against a Sepolia RPC first: it prints what the
 * keeper would request today, which is the check that it reads every deployed
 * contract's getters correctly before anything is spent.
 *
 * The author is set BEFORE the name: a name with no author makes `onReport`
 * revert with WorkflowNameRequiresAuthorValidation.
 */
contract DeployKeeper is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        uint32 flightDelay = uint32(vm.envOr("FLIGHT_DELAY", uint256(6 hours)));

        vm.startBroadcast(pk);
        SettlementKeeper keeper = new SettlementKeeper(vm.envAddress("FORWARDER"));
        keeper.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        keeper.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));

        keeper.watch(vm.envAddress("FLIGHT"), SettlementKeeper.Kind.Flight, flightDelay);
        keeper.watch(vm.envAddress("CRYPTO"), SettlementKeeper.Kind.Parimutuel, 0);
        keeper.watch(vm.envAddress("STOCK"), SettlementKeeper.Kind.Parimutuel, 0);
        keeper.watch(vm.envAddress("RESERVE"), SettlementKeeper.Kind.Parimutuel, 0);
        keeper.watch(vm.envAddress("AMM"), SettlementKeeper.Kind.Amm, 0);
        vm.stopBroadcast();

        console2.log("SETTLEMENT_KEEPER", address(keeper));
        console2.logBytes10(keeper.getExpectedWorkflowName());

        (address[] memory markets, uint256[] memory ids) = keeper.dueMarkets(50);
        console2.log("due now:", markets.length);
        for (uint256 i; i < markets.length; i++) console2.log("  ", markets[i], ids[i]);
    }
}
