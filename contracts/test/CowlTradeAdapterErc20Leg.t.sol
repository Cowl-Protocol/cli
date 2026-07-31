// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier} from "../src/ShieldVerifier.sol";
import {CowlTradeAdapter} from "../src/CowlTradeAdapter.sol";
import {MockVerifier, okCipher, okCiphers} from "./ShieldedPool.t.sol";
import {TestWETH, TestUSDG, TestSwapRouter} from "./mocks/TestVenue.sol";
import {SilentFailTransferForToken} from "./mocks/SilentFailToken.sol";

/// The adapter's ERC-20 input leg, and the surplus refund that only that leg can
/// reach.
///
/// `CowlTradeAdapter.t.sol` drives the real bb proofs, and every fixture it has
/// pays in with the native coin. That leaves two branches of `trade()` with no
/// test at all — the ones taken when `spend.token != 0` — and one of them is the
/// refund of unspent input, which moves value with a bare `transfer` whose
/// return value the adapter is supposed to check. `audits/static/README.md`
/// records the gap and calls it untestable until a fixture with an ERC-20 input
/// exists.
///
/// It is testable now, without one. The proof is not what is under test here:
/// the end-to-end file already proves the real verifier accepts these calls and
/// rejects tampered ones. What is under test is the adapter's own arithmetic and
/// its handling of a token that answers in the ERC-20 dialect. So the pool is
/// built on a verifier that accepts, and every other pool defence — the
/// turnstile, the nullifier set, the root ring — stays real and still has to
/// hold.
contract CowlTradeAdapterErc20LegTest is Test {
    ShieldedPool pool;
    CowlTradeAdapter adapter;
    TestWETH weth;
    TestUSDG usdg;
    TestSwapRouter router;

    /// 3e18 = the fixtures' rate: 900 USDG units buy 300 wei, and back again.
    uint256 constant RATE = 3e18;

    /// Shielded in, and the ceiling the spend authorises.
    uint256 constant SHIELDED_IN = 1000;
    /// What the trade asks to receive, in wei of the native coin.
    uint256 constant WANT_OUT = 300;
    /// What the venue charges for it, at RATE.
    uint256 constant COSTS = 900;
    /// Which leaves this much of the input unspent, and needing a home.
    uint256 constant SURPLUS = SHIELDED_IN - COSTS;

    bytes32 constant SPEND_ROOT = bytes32(uint256(0xB0B));

    function setUp() public {
        pool = new ShieldedPool(
            IVerifier(address(new MockVerifier())), IVerifier(address(new MockVerifier())))
        ;

        weth = new TestWETH();
        usdg = new TestUSDG();
        router = new TestSwapRouter(address(weth), address(usdg), RATE);
        adapter = new CowlTradeAdapter(pool, address(router), address(weth), false);

        // The venue pays out in WETH, so it has to hold some — and wrapping it
        // here is also what puts the ether behind it that the adapter's unwrap
        // will draw on.
        vm.deal(address(router), 1 ether);
        vm.prank(address(router));
        weth.deposit{value: 1 ether}();

        // Shield the ERC-20 that will pay for the trade. This is the leg the
        // native fixtures never exercise.
        usdg.mint(address(this), SHIELDED_IN);
        usdg.approve(address(pool), SHIELDED_IN);
        pool.shield(
            uint256(uint160(address(usdg))),
            SHIELDED_IN,
            bytes32(uint256(1)),
            SPEND_ROOT,
            okCipher(),
            hex""
        );
    }

    function _params() internal view returns (CowlTradeAdapter.TradeParams memory p) {
        p.spend = ShieldedPool.Spend({
            membershipRoot: SPEND_ROOT,
            nullifiers: [bytes32(uint256(11)), bytes32(uint256(12))],
            commitments: [bytes32(uint256(21)), bytes32(uint256(22))],
            newRoot: bytes32(uint256(0xC0FFEE)),
            token: uint256(uint160(address(usdg))),
            value: SHIELDED_IN,
            fee: 0,
            recipient: address(adapter),
            relayer: address(0)
        });
        p.spendCiphertexts = okCiphers();
        p.spendProof = hex"";
        p.tokenOut = 0; // native out, so the adapter unwraps and shields ether
        p.amountOut = WANT_OUT;
        p.poolFee = 3000;
        p.shieldCommitment = bytes32(uint256(31));
        p.shieldNewRoot = bytes32(uint256(0xDECAF));
        p.shieldCiphertext = okCipher();
        p.shieldProof = hex"";
    }

    /// The branch itself: an ERC-20 input leg, and the surplus going back to
    /// whoever submitted the trade rather than sitting on a contract with no
    /// sweep.
    function test_an_erc20_input_leg_refunds_its_surplus_to_the_submitter() public {
        assertEq(usdg.balanceOf(address(this)), 0, "start with nothing to confuse the refund");

        adapter.trade(_params());

        // The surplus came back to the submitter, in the input token.
        assertEq(usdg.balanceOf(address(this)), SURPLUS);

        // What the venue was actually paid, and what it paid back.
        assertEq(usdg.balanceOf(address(router)), COSTS);
        assertEq(address(pool).balance, WANT_OUT);

        // Both turnstiles moved by exactly the right amount and no more: the
        // whole authorised input left the pool, the output arrived.
        assertEq(pool.pooledValue(uint256(uint160(address(usdg)))), 0);
        assertEq(pool.pooledValue(0), WANT_OUT);

        // The adapter holds nothing afterwards, in any denomination. It has no
        // sweep, so anything left here is left forever.
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(address(adapter).balance, 0);

        // And the pool's own state advanced the way a spend plus a shield does.
        assertTrue(pool.nullifierSpent(bytes32(uint256(11))));
        assertTrue(pool.committed(bytes32(uint256(31))));
        assertEq(pool.root(), bytes32(uint256(0xDECAF)));
    }

    /// An exact fill leaves nothing over, so the refund never runs. Worth
    /// pinning because it is the boundary either side of `left != 0`, and a
    /// refund that fired on zero would revert a perfectly good trade.
    function test_an_exact_fill_skips_the_refund_entirely() public {
        CowlTradeAdapter.TradeParams memory p = _params();
        p.spend.value = COSTS; // authorise exactly what the venue charges

        adapter.trade(p);

        assertEq(usdg.balanceOf(address(this)), 0, "nothing over, nothing sent");
        assertEq(usdg.balanceOf(address(router)), COSTS);
        assertEq(pool.pooledValue(uint256(uint160(address(usdg)))), SURPLUS, "the rest stays shielded");
        assertEq(pool.pooledValue(0), WANT_OUT);
        assertEq(usdg.balanceOf(address(adapter)), 0);
    }

    /// The reason the return value is checked at all. A token that reports
    /// failure by returning `false` would, unchecked, leave the surplus stranded
    /// on the adapter while the spend stayed nullified and the trade reported
    /// success. Checked, the whole trade unwinds instead — which is the
    /// contract's own promise: revert anywhere and it never happened.
    ///
    /// This is L-02 from the static scan, fixed in `8b1c58f`. Until now only its
    /// approval twin had a test, because the refund path needs an ERC-20 input.
    function test_a_silent_refund_failure_unwinds_the_whole_trade() public {
        // A token that fails only for the adapter, so the pool's own payout —
        // also a `transfer` — still succeeds and the trade reaches the refund.
        SilentFailTransferForToken hostile = new SilentFailTransferForToken();
        vm.etch(address(usdg), address(hostile).code);
        SilentFailTransferForToken(address(usdg)).setFailFor(address(adapter));
        SilentFailTransferForToken(address(usdg)).mint(address(pool), SHIELDED_IN);

        vm.expectRevert(CowlTradeAdapter.RefundFailed.selector);
        adapter.trade(_params());

        // Nothing happened: the note is unspent, the pool still holds the input,
        // and no output was minted into the tree.
        assertFalse(pool.nullifierSpent(bytes32(uint256(11))));
        assertEq(pool.pooledValue(uint256(uint160(address(usdg)))), SHIELDED_IN);
        assertEq(pool.pooledValue(0), 0);
        assertEq(pool.root(), SPEND_ROOT);
        assertEq(address(adapter).balance, 0);
    }

    /// The adapter refuses to trade an asset for itself. Reachable only with an
    /// ERC-20 input, since a native leg is compared as WETH against a different
    /// output token.
    function test_an_erc20_leg_cannot_trade_an_asset_for_itself() public {
        CowlTradeAdapter.TradeParams memory p = _params();
        p.tokenOut = uint256(uint160(address(usdg)));

        vm.expectRevert(CowlTradeAdapter.SameAsset.selector);
        adapter.trade(p);
    }
}
