// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {IVerifier, ShieldVerifier} from "../src/ShieldVerifier.sol";
import {TransferVerifier} from "../src/TransferVerifier.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";

/// Deploys both verifiers and the pool pointing at them.
///
///   forge script script/Deploy.s.sol \
///     --rpc-url https://46630.rpc.thirdweb.com \
///     --account cowl-deployer --broadcast
///
/// Set SHIELD_VERIFIER or TRANSFER_VERIFIER to reuse one already on chain
/// instead of deploying another. A verifier is generated from its circuit, so it
/// only needs replacing when that circuit changes — a pool-only change (an
/// event, a storage map) should not spend the gas or strand a verifier that was
/// already checked against a real proof:
///
///   SHIELD_VERIFIER=0x... forge script script/Deploy.s.sol ...
///
/// The pool records its own deploy block; put it in cli/src/networks.ts as
/// poolDeployBlock so a cold sync does not replay the chain from genesis.
contract Deploy is Script {
    function run() external {
        address existingShield = vm.envOr("SHIELD_VERIFIER", address(0));
        address existingTransfer = vm.envOr("TRANSFER_VERIFIER", address(0));

        vm.startBroadcast();
        address shield =
            existingShield == address(0) ? address(new ShieldVerifier()) : existingShield;
        address transfer =
            existingTransfer == address(0) ? address(new TransferVerifier()) : existingTransfer;
        ShieldedPool pool = new ShieldedPool(IVerifier(shield), IVerifier(transfer));
        vm.stopBroadcast();

        console.log("ShieldVerifier:  ", shield, existingShield == address(0) ? "(new)" : "(reused)");
        console.log("TransferVerifier:", transfer, existingTransfer == address(0) ? "(new)" : "(reused)");
        console.log("ShieldedPool:    ", address(pool));
        console.log("deployBlock:     ", block.number);
    }
}
