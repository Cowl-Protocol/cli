// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier, ShieldVerifier} from "../src/ShieldVerifier.sol";
import {TransferVerifier} from "../src/TransferVerifier.sol";
import {CowlTradeAdapter} from "../src/CowlTradeAdapter.sol";
import {TestWETH, TestUSDG, TestSwapRouter, TestSwapRouter02} from "../src/TestVenue.sol";

/// The real thing, end to end: bb's own proofs drive an atomic private trade —
/// unshield to the adapter, swap on the venue, shield the output back — against
/// the real pool and the real verifiers. The fixtures pin the adapter and USDG
/// addresses inside the proofs, so the test etches its contracts at exactly
/// those addresses instead of hoping deployment order cooperates.
contract CowlTradeAdapterTest is Test {
    ShieldedPool pool;
    CowlTradeAdapter adapter;
    TestWETH weth;
    TestUSDG usdg;
    TestSwapRouter router;

    bytes depositProof;
    bytes32[] depositInputs;
    bytes spendProof;
    bytes32[] spendInputs;
    bytes shieldProof;
    bytes32[] shieldInputs;

    /// 900 USDG units out for 300 wei in — the rate the fixtures were built for.
    uint256 constant RATE = 3e18;

    function okCipher() internal pure returns (bytes memory) {
        return new bytes(158);
    }

    function okCiphers() internal pure returns (bytes[2] memory cts) {
        cts[0] = okCipher();
        cts[1] = okCipher();
    }

    function setUp() public {
        // The trade-spend proof binds chain 46630, like every spend.
        vm.chainId(46630);
        pool = new ShieldedPool(
            IVerifier(address(new ShieldVerifier())), IVerifier(address(new TransferVerifier()))
        );

        depositProof = vm.readFileBinary("../circuits/target/shield-fixture/proof");
        depositInputs = vm.parseJsonBytes32Array(
            vm.readFile("../circuits/target/shield-fixture/public_inputs.json"), ".publicInputs"
        );
        spendProof = vm.readFileBinary("../circuits/target/trade-spend-fixture/proof");
        spendInputs = vm.parseJsonBytes32Array(
            vm.readFile("../circuits/target/trade-spend-fixture/public_inputs.json"), ".publicInputs"
        );
        shieldProof = vm.readFileBinary("../circuits/target/trade-shield-fixture/proof");
        shieldInputs = vm.parseJsonBytes32Array(
            vm.readFile("../circuits/target/trade-shield-fixture/public_inputs.json"), ".publicInputs"
        );

        // The proofs name the adapter (spend recipient) and the USDG token
        // (shield token) — put the contracts exactly there.
        address adapterAddr = address(uint160(uint256(spendInputs[11])));
        address usdgAddr = address(uint160(uint256(shieldInputs[0])));

        weth = new TestWETH();
        TestUSDG usdgTemplate = new TestUSDG();
        vm.etch(usdgAddr, address(usdgTemplate).code);
        usdg = TestUSDG(usdgAddr);
        router = new TestSwapRouter(address(weth), usdgAddr, RATE);
        usdg.mint(address(router), 1_000_000_000000);

        CowlTradeAdapter template = new CowlTradeAdapter(pool, address(router), address(weth), false);
        vm.etch(adapterAddr, address(template).code);
        adapter = CowlTradeAdapter(payable(adapterAddr));
    }

    function _deposit() internal {
        pool.shield{value: uint256(depositInputs[1])}(
            uint256(depositInputs[0]),
            uint256(depositInputs[1]),
            depositInputs[2],
            depositInputs[4],
            okCipher(),
            depositProof
        );
    }

    function _params() internal view returns (CowlTradeAdapter.TradeParams memory p) {
        p.spend = ShieldedPool.Spend({
            membershipRoot: spendInputs[0],
            nullifiers: [spendInputs[1], spendInputs[2]],
            commitments: [spendInputs[3], spendInputs[4]],
            newRoot: spendInputs[6],
            token: uint256(spendInputs[8]),
            value: uint256(spendInputs[9]),
            fee: uint256(spendInputs[10]),
            recipient: address(uint160(uint256(spendInputs[11]))),
            relayer: address(uint160(uint256(spendInputs[12])))
        });
        p.spendCiphertexts = okCiphers();
        p.spendProof = spendProof;
        p.tokenOut = uint256(shieldInputs[0]);
        p.amountOut = uint256(shieldInputs[1]);
        p.poolFee = 3000;
        p.shieldCommitment = shieldInputs[2];
        p.shieldNewRoot = shieldInputs[4];
        p.shieldCiphertext = okCipher();
        p.shieldProof = shieldProof;
    }

    function test_private_trade_end_to_end() public {
        _deposit();
        adapter.trade(_params());

        // The input note is gone and the trade's three leaves are in.
        assertTrue(pool.nullifierSpent(spendInputs[1]));
        assertEq(pool.nextLeafIndex(), 4); // deposit + change + filler + USDG note
        assertEq(pool.root(), shieldInputs[4]);
        assertTrue(pool.committed(shieldInputs[2]));

        // Value went where the proofs said: 300 wei to the venue, 900 USDG
        // units back into the pool, and the turnstile tracked both tokens.
        assertEq(weth.balanceOf(address(router)), 300);
        assertEq(usdg.balanceOf(address(pool)), 900);
        assertEq(address(pool).balance, 700);
        assertEq(pool.pooledValue(0), 700);
        assertEq(pool.pooledValue(uint256(shieldInputs[0])), 900);

        // The adapter kept nothing.
        assertEq(address(adapter).balance, 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0);
    }

    /// The same trade through a SwapRouter02-style venue — no deadline in the
    /// params, different selector, same proofs. This is the mainnet (pons)
    /// dialect; the test double exposes ONLY the 02 entrypoint, so a classic
    /// encoding would fail here the way it fails on the real router.
    function test_private_trade_end_to_end_router02() public {
        TestSwapRouter02 router02 = new TestSwapRouter02(address(weth), address(usdg), RATE);
        usdg.mint(address(router02), 1_000_000_000000);
        CowlTradeAdapter template = new CowlTradeAdapter(pool, address(router02), address(weth), true);
        vm.etch(address(adapter), address(template).code);

        _deposit();
        adapter.trade(_params());

        assertTrue(pool.nullifierSpent(spendInputs[1]));
        assertEq(pool.root(), shieldInputs[4]);
        assertEq(weth.balanceOf(address(router02)), 300);
        assertEq(usdg.balanceOf(address(pool)), 900);
        assertEq(pool.pooledValue(uint256(shieldInputs[0])), 900);
        assertEq(address(adapter).balance, 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
    }

    /// The money property: break anything and the trade never happened. A
    /// corrupted shield proof reverts the whole call — the nullifiers come
    /// back, the deposit stays whole, nothing is stranded on the adapter.
    function test_a_failed_leg_unwinds_the_whole_trade() public {
        _deposit();
        CowlTradeAdapter.TradeParams memory p = _params();
        p.shieldProof[64] ^= bytes1(0xff);

        vm.expectRevert();
        adapter.trade(p);

        assertFalse(pool.nullifierSpent(spendInputs[1]));
        assertEq(pool.nextLeafIndex(), 1);
        assertEq(address(pool).balance, 1000);
        assertEq(address(adapter).balance, 0);
        assertEq(weth.balanceOf(address(adapter)), 0);
    }

    function test_rejects_a_spend_paying_someone_else() public {
        _deposit();
        CowlTradeAdapter.TradeParams memory p = _params();
        p.spend.recipient = address(0xB0B);

        vm.expectRevert(CowlTradeAdapter.NotMyPayout.selector);
        adapter.trade(p);
    }

    function test_wrong_output_amount_cannot_shield() public {
        _deposit();
        CowlTradeAdapter.TradeParams memory p = _params();
        p.amountOut = p.amountOut - 1; // swap succeeds, but the proof binds 900

        vm.expectRevert();
        adapter.trade(p);
        assertFalse(pool.nullifierSpent(spendInputs[1]));
    }
}
