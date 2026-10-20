// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MarketScheduler} from "../src/MarketScheduler.sol";

/**
 * Deploys MarketScheduler against all five market contracts.
 *
 * Required env: DEPLOYER_PK, FORWARDER, WORKFLOW_NAME, WORKFLOW_AUTHOR,
 * CRYPTO, STOCK, RESERVE, FLIGHT, AMM, TOKEN (MockUSDC, for AMM liquidity).
 * The author is set BEFORE the name: a name with no author makes `onReport`
 * revert with WorkflowNameRequiresAuthorValidation.
 *
 * The first scheduler (2026-10-19, `0x8559…B01e`) opened crypto markets only;
 * adopt its slots into this one with `adopt` so none opens twice.
 */
contract DeployScheduler is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        MarketScheduler s = new MarketScheduler(
            vm.envAddress("FORWARDER"),
            MarketScheduler.Targets({
                crypto: vm.envAddress("CRYPTO"),
                stock: vm.envAddress("STOCK"),
                reserve: vm.envAddress("RESERVE"),
                flight: vm.envAddress("FLIGHT"),
                amm: vm.envAddress("AMM"),
                usdc: vm.envAddress("TOKEN")
            })
        );
        s.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        s.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        vm.stopBroadcast();

        console2.log("MARKET_SCHEDULER", address(s));
        console2.logBytes10(s.getExpectedWorkflowName());
    }
}
