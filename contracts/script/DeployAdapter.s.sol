// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {CowlTradeAdapter} from "../src/CowlTradeAdapter.sol";

/// Deploys the trade adapter against the live pool and venue.
///
///   forge script script/DeployAdapter.s.sol \
///     --rpc-url https://46630.rpc.thirdweb.com \
///     --account cowl-deployer --broadcast
///
/// Defaults point at the current testnet pool and venue; override with POOL,
/// ROUTER, WETH env vars for another deployment. Put the printed address into
/// cli/src/networks.ts as `tradeAdapter`.
contract DeployAdapter is Script {
    function run() external {
        address pool = vm.envOr("POOL", address(0xf9F825f2D6d8509c78baaa587694f74672C32A59));
        address router = vm.envOr("ROUTER", address(0xbd610c3A708C483a64dC2C92876C2D1a8Ef43b03));
        address weth = vm.envOr("WETH", address(0xdC155cafBa4D26790781c12e4B1001F933496Da2));

        vm.startBroadcast();
        CowlTradeAdapter adapter = new CowlTradeAdapter(ShieldedPool(payable(pool)), router, weth);
        vm.stopBroadcast();

        console.log("CowlTradeAdapter:", address(adapter));
        console.log("pool:            ", pool);
        console.log("router:          ", router);
        console.log("weth:            ", weth);
    }
}
