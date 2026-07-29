// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {IVerifier} from "../src/ShieldVerifier.sol";
import {MockVerifier, MockERC20, okCipher, okCiphers} from "./ShieldedPool.t.sol";
import {PoolHandler} from "./PoolHandler.sol";

/// The six pool invariants, run under random call sequences.
///
/// A concrete test fixes the order it calls things in, which is the one thing an
/// accounting bug hides behind. These properties are stated so they must hold
/// after every call in any order, with the proof system assumed broken (see the
/// header on `PoolHandler`). What is left is the pool's own guarantee.
contract ShieldedPoolInvariants is Test {
    ShieldedPool pool;
    PoolHandler handler;

    function setUp() public {
        pool = new ShieldedPool(
            IVerifier(address(new MockVerifier())), IVerifier(address(new MockVerifier()))
        );
        handler = new PoolHandler(pool);

        // Only the handler drives the pool. Left unrestricted, the fuzzer would
        // call the pool directly with unbounded garbage that reverts on the
        // first field check and exercises nothing.
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = PoolHandler.shieldNative.selector;
        selectors[1] = PoolHandler.shieldToken.selector;
        selectors[2] = PoolHandler.spendPayout.selector;
        selectors[3] = PoolHandler.spendPrivate.selector;
        selectors[4] = PoolHandler.replayNullifier.selector;
        selectors[5] = PoolHandler.replayCommitment.selector;
        selectors[6] = PoolHandler.spendAgainstEvictedRoot.selector;
        selectors[7] = PoolHandler.forceFeedNative.selector;
        selectors[8] = PoolHandler.proposeVerifierSwap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// 1. `pooledValue[token]` never exceeds what the pool actually holds.
    ///
    /// Written as "never exceeds" and not "equals" because value can arrive
    /// without a deposit: the pool has no `receive()`, but a `selfdestruct`
    /// lands anyway and belongs to nobody. The dangerous direction is the other
    /// one, an accounting entry with no asset behind it, and that is what this
    /// catches.
    function invariant_pooled_value_never_exceeds_the_balance_behind_it() public view {
        assertLe(pool.pooledValue(0), address(pool).balance, "native turnstile outran its balance");
        for (uint256 i = 1; i < 3; i++) {
            uint256 token = handler.tokenAt(i);
            assertLe(
                pool.pooledValue(token),
                MockERC20(address(uint160(token))).balanceOf(address(pool)),
                "token turnstile outran its balance"
            );
        }
    }

    /// 2. A nullifier is never accepted twice.
    ///
    /// The handler replays burned nullifiers on purpose. Every acceptance is
    /// recorded rather than thrown at the call site, so the failure arrives with
    /// the whole sequence that produced it.
    function invariant_a_nullifier_is_never_accepted_twice() public view {
        assertFalse(handler.nullifierAcceptedTwice(), "a burned nullifier was spent again");
    }

    /// 3. A commitment is never inserted twice. Two identical leaves would give
    /// one note two spendable positions in the tree.
    function invariant_a_commitment_is_never_accepted_twice() public view {
        assertFalse(handler.commitmentAcceptedTwice(), "a commitment was inserted twice");
    }

    /// 4. Everything that has ever left a token is covered by what was put into
    /// that token. The turnstile checks one spend at a time against a running
    /// balance; this is the cumulative claim over the entire history, and it is
    /// the one that matters, since a drain is a sequence and not a call.
    function invariant_outflow_never_exceeds_inflow_per_token() public view {
        for (uint256 i = 0; i < 3; i++) {
            uint256 token = handler.tokenAt(i);
            assertLe(
                handler.ghostOutflow(token),
                handler.ghostInflow(token),
                "more left this token than ever entered it"
            );
        }
    }

    /// 5. `nextLeafIndex` accounts for exactly the leaves that were inserted, and
    /// never passes the tree it indexes.
    ///
    /// Stated as an equality against the shadow count rather than as plain
    /// monotonicity, because the damaging failure is a stall rather than a
    /// rewind: an index that fails to advance hands the next insertion a
    /// position the tree already holds, and monotonicity alone reads that as
    /// fine.
    function invariant_leaf_index_accounts_for_every_inserted_leaf() public view {
        assertFalse(handler.leafIndexWentBackwards(), "leaf index moved backwards");
        assertEq(
            uint256(pool.nextLeafIndex()),
            handler.expectedLeafIndex(),
            "leaf index does not match the leaves actually inserted"
        );
        assertLe(pool.nextLeafIndex(), pool.MAX_LEAVES(), "leaf index left the tree");
    }

    /// 6. Every root the pool advanced to is retrievable for as long as the ring
    /// retains it, and the current root always is. A root that goes missing
    /// early strands notes proven against it.
    function invariant_recent_roots_stay_retrievable() public view {
        assertTrue(pool.knownRoot(pool.root()), "the current root is not retrievable");

        uint256 n = handler.rootCount();
        uint256 retained = pool.ROOT_HISTORY();
        uint256 from = n > retained ? n - retained : 0;
        for (uint256 i = from; i < n; i++) {
            assertTrue(pool.knownRoot(handler.rootAt(i)), "a retained root went missing");
        }
    }

}

/// The guard on the suite above, and the reason it is a concrete test.
///
/// `fail_on_revert` is off, because the handler is meant to be told no. The
/// price of that setting is that a handler which reverted on every single call
/// would satisfy all six invariants without ever touching the pool, and the run
/// would be green and worthless. Something has to prove the actions land.
///
/// The obvious home for that check is `afterInvariant()`, and it does not work
/// here: on forge 1.7.1 the handler state visible from `afterInvariant` is not
/// the state the campaign built. Running this file, five of the six invariants
/// saw every counter at zero while the sixth saw 26 deposits and 26 spends, from
/// the same handler in the same run. So the guard is written as a fixed
/// sequence instead, which proves the same thing and cannot drift with a
/// fuzzer or a Foundry release.
contract HandlerReachesThePool is Test {
    ShieldedPool pool;
    PoolHandler handler;

    function setUp() public {
        pool = new ShieldedPool(
            IVerifier(address(new MockVerifier())), IVerifier(address(new MockVerifier()))
        );
        handler = new PoolHandler(pool);
    }

    function test_every_action_reaches_the_pool() public {
        handler.shieldNative(5 ether);
        handler.shieldToken(1, 1000e18);
        handler.shieldToken(2, 2000e18);
        assertEq(handler.shieldsAccepted(), 3, "deposits did not land");
        assertEq(handler.expectedLeafIndex(), 3);

        handler.spendPayout(0, 1 ether, 0, false); // native, inside the turnstile
        handler.spendPrivate(1); // value zero, nothing leaves
        assertEq(handler.spendsAccepted(), 2, "spends did not land");

        // And the refusals the invariants are built to notice.
        handler.spendPayout(0, 0, 0, true); // asks for more than the pool holds
        assertGt(handler.turnstileBlocks(), 0, "the turnstile never said no");

        handler.replayNullifier(0, 0);
        handler.replayCommitment(0, 0);
        assertGt(handler.replaysBlocked(), 1, "replays were never refused");
        assertFalse(handler.nullifierAcceptedTwice());
        assertFalse(handler.commitmentAcceptedTwice());

        // Value arriving without a deposit must not move the accounting.
        uint256 pooledBefore = pool.pooledValue(0);
        handler.forceFeedNative(3 ether);
        assertEq(pool.pooledValue(0), pooledBefore, "a forced transfer moved the turnstile");
        assertGt(address(pool).balance, pool.pooledValue(0), "the force feed did not arrive");

        console.log("deposits accepted ", handler.shieldsAccepted());
        console.log("spends accepted   ", handler.spendsAccepted());
        console.log("turnstile blocks  ", handler.turnstileBlocks());
        console.log("replays blocked   ", handler.replaysBlocked());
        console.log("leaves inserted   ", pool.nextLeafIndex());
    }

    /// The stale-root action is the one that needs a wrapped ring to mean
    /// anything, which is why the suite runs at depth 160 rather than the 64 it
    /// started on: at 64 a sequence never produced more than about 31 roots, the
    /// ring never evicted, and the action returned early every single time.
    function test_an_evicted_root_is_refused() public {
        for (uint256 i = 0; i < 40; i++) {
            handler.shieldNative(i + 1);
        }
        bytes32 early = handler.rootAt(1);
        assertFalse(pool.knownRoot(early), "the ring did not evict, this test needs a longer walk");

        handler.spendAgainstEvictedRoot(1, 0);
        assertGt(handler.staleRootBlocks(), 0, "an evicted root was not refused");
    }
}

/// Two assumptions the pool makes about its inputs that the circuits supply and
/// the Solidity does not re-derive. Neither is reachable through a real
/// verifier, which is why they sit here as concrete tests rather than as
/// invariants: the suite above generates distinct roots precisely because a
/// sound circuit cannot produce anything else.
contract RootRingAssumptions is Test {
    ShieldedPool pool;

    function setUp() public {
        pool = new ShieldedPool(
            IVerifier(address(new MockVerifier())), IVerifier(address(new MockVerifier()))
        );
    }

    function _f(string memory label) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(bytes(label))) >> 8);
    }

    function _fill(uint256 count, string memory tag) internal {
        for (uint256 i = 0; i < count; i++) {
            string memory label = string.concat(tag, vm.toString(i));
            pool.shield{value: 1}(0, 1, _f(string.concat("c", label)), _f(label), okCipher(), "");
        }
    }

    /// The ring assumes the roots it is handed are distinct. Insert the same
    /// root twice and evicting the older copy clears the flag for the newer one,
    /// so a root still inside the window reports as unknown and spends proven
    /// against it revert.
    ///
    /// A sound insertion circuit cannot produce this: `newRoot` is constrained
    /// as the result of inserting a specific leaf at a specific index, so two
    /// insertions collide only if Poseidon2 does. Recorded because the pool
    /// leans on that guarantee without restating it.
    function test_a_repeated_root_is_evicted_early() public {
        bytes32 repeated = _f("repeated");
        vm.deal(address(this), 100 ether);

        pool.shield{value: 1}(0, 1, _f("c-first"), repeated, okCipher(), "");
        _fill(4, "gap");
        pool.shield{value: 1}(0, 1, _f("c-second"), repeated, okCipher(), "");
        assertTrue(pool.knownRoot(repeated));

        // Walk the ring far enough to evict the first copy but not the second.
        _fill(28, "walk");

        assertFalse(
            pool.knownRoot(repeated),
            "the assumption held after all, this test is now the wrong shape"
        );
    }

    /// Eviction skips the zero slot, which is how the ring tells an unused entry
    /// from a real one. A root of zero is therefore never cleared and stays
    /// spendable forever.
    ///
    /// Also unreachable through a sound circuit: reaching root zero means
    /// finding a Poseidon2 preimage chain to zero. The consequence is bounded by
    /// the same soundness the rest of the pool already rests on, and the cost of
    /// closing it is a storage slot per insertion.
    function test_a_zero_root_is_never_evicted() public {
        vm.deal(address(this), 100 ether);
        pool.shield{value: 1}(0, 1, _f("c-zero"), bytes32(0), okCipher(), "");
        assertTrue(pool.knownRoot(bytes32(0)));

        _fill(40, "past");

        assertTrue(pool.knownRoot(bytes32(0)), "zero was evicted, this test is now the wrong shape");
        // Every other root from that far back is gone, which is the contrast.
        assertFalse(pool.knownRoot(_f("past0")));
    }
}
