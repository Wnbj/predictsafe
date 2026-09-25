// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AssetExchange, IPriceFeed} from "../src/AssetExchange.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/**
 * Deploys AssetExchange, lists gold and the S&P 500 fund, and seeds the reserve.
 *
 * Required env:
 *   DEPLOYER_PK      - key to deploy and own from
 *   TOKEN            - MockUSDC
 *   FORWARDER        - the KeystoneForwarder allowed to deliver fill reports
 *   WORKFLOW_NAME    - the workflow whose reports are accepted
 *   WORKFLOW_AUTHOR  - the owner the DON presents for that workflow
 * Optional env:
 *   RESERVE          - mUSDC to seed the reserve with, 6 decimals (default 10,000)
 *
 * The author is set BEFORE the name: a name with no author makes `onReport`
 * revert with WorkflowNameRequiresAuthorValidation.
 *
 * Feeds chosen by measurement, September 2026, Sepolia:
 *   XAU/USD  - hourly, a new price on every weekday round; frozen on Saturday
 *   CSPX/USD - daily; the same price republished every Sunday
 * IB01 and USTB were measured too and left out: about half their rounds repeat
 * the previous price even on weekdays, which makes a dull and slow market.
 */
contract DeployExchange is Script {
    address constant XAU_FEED = 0xC5981F461d74c46eB4b0CF3f4Ec79f025573B0Ea;
    address constant CSPX_FEED = 0x4b531A318B0e44B549F3b2f824721b3D0d51930A;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address token = vm.envAddress("TOKEN");
        address forwarder = vm.envAddress("FORWARDER");
        string memory workflowName = vm.envString("WORKFLOW_NAME");
        address workflowAuthor = vm.envAddress("WORKFLOW_AUTHOR");
        uint256 reserve = vm.envOr("RESERVE", uint256(10_000e6));

        vm.startBroadcast(pk);
        AssetExchange ex = new AssetExchange(IERC20(token), forwarder);
        ex.setExpectedAuthor(workflowAuthor);
        ex.setExpectedWorkflowName(workflowName);

        ex.listAsset("XAU", "Synthetic Gold", IPriceFeed(XAU_FEED));
        ex.listAsset("CSPX", "Synthetic S&P 500 (CSPX)", IPriceFeed(CSPX_FEED));

        MockUSDC(token).mint(vm.addr(pk), reserve);
        IERC20(token).approve(address(ex), reserve);
        ex.fundReserve(reserve);
        vm.stopBroadcast();

        (,, address sXAU,,) = ex.asset(0);
        (,, address sCSPX,,) = ex.asset(1);
        console2.log("ASSET_EXCHANGE  ", address(ex));
        console2.log("sXAU            ", sXAU);
        console2.log("sCSPX           ", sCSPX);
        console2.log("RESERVE         ", ex.reserveAvailable());
        console2.logBytes10(ex.getExpectedWorkflowName());
    }
}
