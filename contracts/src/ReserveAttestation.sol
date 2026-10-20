// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./interfaces/ReceiverTemplate.sol";

/**
 * @title ReserveAttestation
 * @notice Is the exchange backed off-chain? Answered by a Chainlink CONFIDENTIAL
 *         workflow, which reads a custodian's account inside a TEE and
 *         publishes a coverage band — never the balance.
 *
 *  The workflow (cre/reserve-attestation) reads what the exchange's tokens are
 *  worth from the chain, which is public anyway; unseals the custodian's API
 *  key inside an attested enclave; fetches the account there; and compares
 *  the two there. Only the conclusion crosses back to the DON:
 *
 *      abi.encode(uint8 band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash)
 *
 *  WHY A BAND AND NOT A PERCENTAGE. With the obligations on chain, an exact
 *  coverage ratio IS the balance — multiply one by the other. So the report
 *  says only which side of 100%, 150% and 200% it falls on.
 *
 *  `evidenceHash` is keccak256(apiKey ‖ custodian response): binding — the
 *  custodian or an auditor holding the key can recompute it — but useless to
 *  anyone without the key, who could otherwise brute-force a small balance out
 *  of a plain hash of the response.
 *
 *  A report older than the latest one, or dated in the future, is refused:
 *  attestations only move forward in time.
 */
contract ReserveAttestation is ReceiverTemplate {
    /// Coverage below 100%, at least 100%, at least 150%, at least 200%.
    uint8 public constant BELOW = 0;
    uint8 public constant AT_LEAST_100 = 1;
    uint8 public constant AT_LEAST_150 = 2;
    uint8 public constant AT_LEAST_200 = 3;

    /// Clock skew allowed between the custodian and the chain.
    uint64 public constant MAX_FUTURE = 10 minutes;

    struct Attestation {
        uint8 band;
        /// What the tokens were worth when it was attested, in mUSDC (6 decimals).
        uint256 obligations;
        /// The custodian's own timestamp for the balance.
        uint64 balanceAsOf;
        uint64 attestedAt;
        bytes32 evidenceHash;
    }

    Attestation internal _latest;
    uint256 public count;

    event Attested(uint8 indexed band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash);

    error BadBand(uint8 band);
    error Stale(uint64 balanceAsOf, uint64 latest);
    error FromTheFuture(uint64 balanceAsOf);

    constructor(address forwarder) ReceiverTemplate(forwarder) {}

    function latest() external view returns (Attestation memory) {
        return _latest;
    }

    /// Whether the last attestation found the tokens fully backed.
    function covered() external view returns (bool) {
        return count > 0 && _latest.band >= AT_LEAST_100;
    }

    function _processReport(bytes calldata report) internal override {
        (uint8 band, uint256 obligations, uint64 balanceAsOf, bytes32 evidenceHash) =
            abi.decode(report, (uint8, uint256, uint64, bytes32));
        if (band > AT_LEAST_200) revert BadBand(band);
        if (balanceAsOf > block.timestamp + MAX_FUTURE) revert FromTheFuture(balanceAsOf);
        if (count > 0 && balanceAsOf < _latest.balanceAsOf) revert Stale(balanceAsOf, _latest.balanceAsOf);

        _latest = Attestation({
            band: band,
            obligations: obligations,
            balanceAsOf: balanceAsOf,
            attestedAt: uint64(block.timestamp),
            evidenceHash: evidenceHash
        });
        count++;
        emit Attested(band, obligations, balanceAsOf, evidenceHash);
    }
}
