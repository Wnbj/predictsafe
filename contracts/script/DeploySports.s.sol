// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SportsMarket} from "../src/SportsMarket.sol";

/**
 * Deploys SportsMarket: football matches as three AMM markets each, opened
 * and settled by the DON from football-data.org.
 *
 * Required env: DEPLOYER_PK, TOKEN (MockUSDC — the contract mints its own
 * liquidity from it), FORWARDER, WORKFLOW_NAME, WORKFLOW_AUTHOR.
 * The author is set BEFORE the name: a name with no author makes `onReport`
 * revert with WorkflowNameRequiresAuthorValidation.
 */
contract DeploySports is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        SportsMarket s = new SportsMarket(IERC20(vm.envAddress("TOKEN")), vm.envAddress("FORWARDER"));
        s.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        s.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        vm.stopBroadcast();
        console2.log("SPORTS_MARKET", address(s));
    }
}
