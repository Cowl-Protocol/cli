// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {HonkVerifier} from "../src/ShieldVerifier.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier} from "../src/ShieldVerifier.sol";

/// Deploys the shield verifier and the pool pointing at it.
///
///   forge script script/Deploy.s.sol \
///     --rpc-url https://46630.rpc.thirdweb.com \
///     --account cowl-deployer --broadcast
///
/// Set VERIFIER to reuse one already on chain instead of deploying another. The
/// verifier is generated from the circuit, so it only needs replacing when the
/// circuit changes — a pool-only change (an event, a storage map) should not
/// spend the gas or strand the verifier that was already checked against a real
/// proof:
///
///   VERIFIER=0x... forge script script/Deploy.s.sol ...
contract Deploy is Script {
    function run() external {
        address existing = vm.envOr("VERIFIER", address(0));

        vm.startBroadcast();
        address verifier = existing == address(0) ? address(new HonkVerifier()) : existing;
        ShieldedPool pool = new ShieldedPool(IVerifier(verifier));
        vm.stopBroadcast();

        console.log("HonkVerifier:", verifier, existing == address(0) ? "(new)" : "(reused)");
        console.log("ShieldedPool:", address(pool));
    }
}
