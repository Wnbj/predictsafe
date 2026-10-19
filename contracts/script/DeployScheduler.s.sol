// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarketScheduler, ICryptoMarketCreate} from "../src/MarketScheduler.sol";

/**
 * Deploys MarketScheduler against CryptoMarket.
 *
 * Required env: DEPLOYER_PK, FORWARDER, WORKFLOW_NAME, WORKFLOW_AUTHOR, CRYPTO.
 * The author is set BEFORE the name: a name with no author makes `onReport`
 * revert with WorkflowNameRequiresAuthorValidation.
 */
contract DeployScheduler is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        MarketScheduler s = new MarketScheduler(vm.envAddress("FORWARDER"), ICryptoMarketCreate(vm.envAddress("CRYPTO")));
        s.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        s.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        vm.stopBroadcast();

        console2.log("MARKET_SCHEDULER", address(s));
        console2.logBytes10(s.getExpectedWorkflowName());
    }
}
