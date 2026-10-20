// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ReserveAttestation} from "../src/ReserveAttestation.sol";

/**
 * Deploys ReserveAttestation, the receiver of the CONFIDENTIAL workflow
 * cre/reserve-attestation — a different workflow from the settlement one, so a
 * different expected name.
 *
 * Required env: DEPLOYER_PK, FORWARDER, WORKFLOW_AUTHOR,
 * WORKFLOW_NAME (predictsafe-reserve).
 */
contract DeployReserveAttestation is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        vm.startBroadcast(pk);
        ReserveAttestation a = new ReserveAttestation(vm.envAddress("FORWARDER"));
        a.setExpectedAuthor(vm.envAddress("WORKFLOW_AUTHOR"));
        a.setExpectedWorkflowName(vm.envString("WORKFLOW_NAME"));
        vm.stopBroadcast();
        console2.log("RESERVE_ATTESTATION", address(a));
        console2.logBytes10(a.getExpectedWorkflowName());
    }
}
