// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ShieldedPool} from "./ShieldedPool.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IERC20Adapter {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

interface IV3Router {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
}

/// The trade adapter — a private trade in one atomic transaction.
///
/// A swap has to touch public liquidity; no circuit changes that. What can be
/// hidden is *whose* swap it was, and that is this contract's whole job:
///
///   1. `pool.spend` unshields the input leg to this adapter. The proof binds
///      the adapter as recipient, so the leg can go nowhere else.
///   2. The router swaps it for an exact amount of the output token.
///   3. `pool.shield` puts exactly that output back under a commitment only
///      the trader's keys can spend.
///
/// All three in one call: revert anywhere and the trade never happened — the
/// nullifiers come back, nothing is stranded, the adapter holds funds for the
/// duration of one transaction and never longer.
///
/// Exact-output is the trick that makes the shield leg provable in advance:
/// the trader knows the output amount before execution, so the client proves
/// the spend against root R and the shield against the root the spend produces,
/// as a chained pair. Any other pool write in between reverts the pair — the
/// same root-serialization every spend already lives with.
///
/// What the chain sees: the pool paid this adapter, the adapter swapped, the
/// pool took a deposit back. Which trader that was dissolves into everyone
/// else using the adapter — submit it through a relayer and the gas trail
/// points nowhere either.
///
/// Any surplus under `amountInMaximum` tips the submitter, never the trader:
/// routing change back toward a public address of the trader would draw the
/// one link this contract exists to avoid.
contract CowlTradeAdapter {
    ShieldedPool public immutable pool;
    address public immutable router;
    address public immutable weth;

    error NotMyPayout();
    error SameAsset();
    error NothingToTrade();

    event Traded(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    constructor(ShieldedPool _pool, address _router, address _weth) {
        pool = _pool;
        router = _router;
        weth = _weth;
    }

    /// The pool pays the unshielded leg here; WETH pays out unwraps here.
    receive() external payable {}

    struct TradeParams {
        /// The unshield leg. `recipient` must be this adapter — the proof
        /// binds it, this contract just fails fast on a mismatch.
        ShieldedPool.Spend spend;
        bytes[2] spendCiphertexts;
        bytes spendProof;
        /// The output side: token id (0 = native), the exact amount to
        /// re-shield, and the router fee tier to swap through.
        uint256 tokenOut;
        uint256 amountOut;
        uint24 poolFee;
        /// The shield leg, proven against the root the spend produces.
        bytes32 shieldCommitment;
        bytes32 shieldNewRoot;
        bytes shieldCiphertext;
        bytes shieldProof;
    }

    function trade(TradeParams calldata p) external {
        if (p.spend.recipient != address(this)) revert NotMyPayout();
        uint256 maxIn = p.spend.value;
        if (maxIn == 0 || p.amountOut == 0) revert NothingToTrade();

        address swapIn = p.spend.token == 0 ? weth : address(uint160(p.spend.token));
        address swapOut = p.tokenOut == 0 ? weth : address(uint160(p.tokenOut));
        if (swapIn == swapOut) revert SameAsset();

        // 1. Unshield to this adapter. Nullifiers, commitments, and the payout
        // all land here — or the whole call reverts and none of it happened.
        pool.spend(p.spend, p.spendCiphertexts, p.spendProof);

        // 2. Swap an exact output. A native input leg arrives as ether and
        // wraps; an ERC-20 leg arrived as itself.
        if (p.spend.token == 0) IWETH(weth).deposit{value: maxIn}();
        IERC20Adapter(swapIn).approve(router, maxIn);
        uint256 spent = IV3Router(router).exactOutputSingle(
            IV3Router.ExactOutputSingleParams({
                tokenIn: swapIn,
                tokenOut: swapOut,
                fee: p.poolFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: p.amountOut,
                amountInMaximum: maxIn,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20Adapter(swapIn).approve(router, 0);

        // 3. Shield the output straight back under the trader's commitment.
        if (p.tokenOut == 0) {
            IWETH(weth).withdraw(p.amountOut);
            pool.shield{value: p.amountOut}(
                0, p.amountOut, p.shieldCommitment, p.shieldNewRoot, p.shieldCiphertext, p.shieldProof
            );
        } else {
            IERC20Adapter(swapOut).approve(address(pool), p.amountOut);
            pool.shield(
                p.tokenOut, p.amountOut, p.shieldCommitment, p.shieldNewRoot, p.shieldCiphertext, p.shieldProof
            );
        }

        // Surplus tips the submitter — never back toward the trader.
        uint256 left = maxIn - spent;
        if (left != 0) {
            if (p.spend.token == 0) {
                IWETH(weth).withdraw(left);
                (bool ok,) = msg.sender.call{value: left}("");
                require(ok, "tip failed");
            } else {
                IERC20Adapter(swapIn).transfer(msg.sender, left);
            }
        }

        emit Traded(swapIn, swapOut, spent, p.amountOut);
    }
}
