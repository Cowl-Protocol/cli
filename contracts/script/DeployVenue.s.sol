// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Script, console} from "forge-std/Script.sol";
import {TestWETH, TestUSDG, TestSwapRouter, TestQuoterV2} from "../src/TestVenue.sol";

/// Deploys the testnet trade venue: WETH, USDG, a fixed-rate V3-shaped router,
/// and its quoter — then seeds the router's inventory so trades clear.
///
///   forge script script/DeployVenue.s.sol \
///     --rpc-url https://46630.rpc.thirdweb.com \
///     --account cowl-deployer --broadcast
///
/// Tunables (env): RATE_USDG_PER_WETH (default 3000 USDG), SEED_WETH in wei
/// (default 0.05 ether, wrapped from the deployer's balance), SEED_USDG in
/// 6-decimal units (default 1,000,000 USDG minted to the router).
contract DeployVenue is Script {
    function run() external {
        uint256 rate = vm.envOr("RATE_USDG_PER_WETH", uint256(3000_000000));
        uint256 seedWeth = vm.envOr("SEED_WETH", uint256(0.05 ether));
        uint256 seedUsdg = vm.envOr("SEED_USDG", uint256(1_000_000_000000));

        vm.startBroadcast();
        TestWETH weth = new TestWETH();
        TestUSDG usdg = new TestUSDG();
        TestSwapRouter router = new TestSwapRouter(address(weth), address(usdg), rate);
        TestQuoterV2 quoter = new TestQuoterV2(router);

        // Inventory: USDG is minted straight to the router; WETH is wrapped
        // from the deployer's own balance and handed over.
        usdg.mint(address(router), seedUsdg);
        weth.deposit{value: seedWeth}();
        weth.transfer(address(router), seedWeth);
        // A pocket of USDG for the deployer, for manual testing.
        usdg.mint(msg.sender, 10_000_000000);
        vm.stopBroadcast();

        console.log("TestWETH:      ", address(weth));
        console.log("TestUSDG:      ", address(usdg));
        console.log("TestSwapRouter:", address(router));
        console.log("TestQuoterV2:  ", address(quoter));
        console.log("rate USDG/WETH:", rate);
        console.log("deployBlock:   ", block.number);
    }
}
