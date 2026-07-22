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
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        HonkVerifier verifier = new HonkVerifier();
        ShieldedPool pool = new ShieldedPool(IVerifier(address(verifier)));
        vm.stopBroadcast();

        console.log("HonkVerifier:", address(verifier));
        console.log("ShieldedPool:", address(pool));
    }
}
