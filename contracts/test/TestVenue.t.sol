// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {TestWETH, TestUSDG, TestSwapRouter, TestQuoterV2, ISwapRouter, IQuoterV2} from "../src/TestVenue.sol";

/// The venue the trade adapter will develop against: a fixed-rate router and
/// quoter wearing the exact Uniswap V3 interface subset. These tests pin the
/// behaviors the adapter will lean on — quote/swap agreement, exact output,
/// max-in enforcement — so a venue bug never masquerades as an adapter bug.
contract TestVenueTest is Test {
    TestWETH weth;
    TestUSDG usdg;
    TestSwapRouter router;
    TestQuoterV2 quoter;

    // 3000 USDG (6 decimals) per WETH.
    uint256 constant RATE = 3000_000000;

    function setUp() public {
        weth = new TestWETH();
        usdg = new TestUSDG();
        router = new TestSwapRouter(address(weth), address(usdg), RATE);
        quoter = new TestQuoterV2(router);

        // Router inventory both ways.
        usdg.mint(address(router), 1_000_000_000000);
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 10 ether}();
        weth.transfer(address(router), 10 ether);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amountOut, uint256 maxIn)
        internal
        returns (uint256)
    {
        return router.exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: amountOut,
                amountInMaximum: maxIn,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_quote_matches_swap_exactly() public {
        (uint256 quoted,,,) = quoter.quoteExactOutputSingle(
            IQuoterV2.QuoteExactOutputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(usdg),
                amount: 150_000000, // 150 USDG out
                fee: 3000,
                sqrtPriceLimitX96: 0
            })
        );

        weth.deposit{value: 1 ether}();
        weth.approve(address(router), type(uint256).max);
        uint256 paid = _swap(address(weth), address(usdg), 150_000000, quoted);

        assertEq(paid, quoted, "the quote is the price");
        assertEq(usdg.balanceOf(address(this)), 150_000000, "exact output delivered");
        // 150 USDG at 3000 USDG/WETH = 0.05 WETH.
        assertEq(paid, 0.05 ether);
    }

    function test_swap_back_the_other_way() public {
        usdg.mint(address(this), 600_000000);
        usdg.approve(address(router), type(uint256).max);
        uint256 paid = _swap(address(usdg), address(weth), 0.1 ether, type(uint256).max);
        // 0.1 WETH at 3000 USDG/WETH = 300 USDG.
        assertEq(paid, 300_000000);
        assertEq(weth.balanceOf(address(this)), 0.1 ether);
    }

    function test_rounding_never_favors_the_trader() public view {
        // 1 base unit of USDG costs a nonzero sliver of WETH, rounded up.
        uint256 inWei = router.amountInFor(address(weth), address(usdg), 1);
        assertGt(inWei, 0);
        // And paying it never yields less than the exact output requested.
        assertGe((inWei * RATE) / 1e18, 1);
    }

    function test_max_in_is_enforced() public {
        weth.deposit{value: 1 ether}();
        weth.approve(address(router), type(uint256).max);
        vm.expectRevert(TestSwapRouter.TooMuchRequested.selector);
        _swap(address(weth), address(usdg), 150_000000, 0.05 ether - 1);
    }

    function test_deadline_is_enforced() public {
        weth.deposit{value: 1 ether}();
        weth.approve(address(router), type(uint256).max);
        vm.expectRevert(TestSwapRouter.Expired.selector);
        router.exactOutputSingle(
            ISwapRouter.ExactOutputSingleParams({
                tokenIn: address(weth),
                tokenOut: address(usdg),
                fee: 3000,
                recipient: address(this),
                deadline: block.timestamp - 1,
                amountOut: 1,
                amountInMaximum: type(uint256).max,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function test_unknown_pair_is_refused() public {
        vm.expectRevert(TestSwapRouter.WrongPair.selector);
        router.amountInFor(address(usdg), address(usdg), 1);
    }

    function test_only_owner_moves_the_rate() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(TestSwapRouter.NotOwner.selector);
        router.setRate(1);

        router.setRate(2500_000000);
        assertEq(router.amountInFor(address(weth), address(usdg), 2500_000000), 1 ether);
    }

    function test_weth_wraps_and_unwraps() public {
        weth.deposit{value: 3 ether}();
        assertEq(weth.balanceOf(address(this)), 3 ether);
        uint256 before = address(this).balance;
        weth.withdraw(1 ether);
        assertEq(address(this).balance, before + 1 ether);
        assertEq(weth.balanceOf(address(this)), 2 ether);
    }

    receive() external payable {}
}
