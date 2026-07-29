// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Test} from "forge-std/Test.sol";
import {ShieldedPool} from "../src/ShieldedPool.sol";
import {MockERC20, okCiphers, okCipher} from "./ShieldedPool.t.sol";

/// Force-feeds native value to an address with no `receive()`. The pool has
/// neither `receive()` nor `fallback()`, so this is the only way value arrives
/// without passing through `shield`, and it is why invariant 1 is written as
/// "never exceeds" rather than "equals".
contract Bomb {
    constructor(address payable target) payable {
        selfdestruct(target);
    }
}

/// Drives the pool through random call sequences and keeps the shadow ledger the
/// invariants are checked against.
///
/// ## The verifier is stubbed to accept everything, on purpose
///
/// This suite asks one question: with the circuits assumed completely broken,
/// does the Solidity still hold the line? Every proof here verifies, so the
/// handler may claim any note, any root and any amount it likes. What survives
/// is exactly the pool's own defence — the per-token turnstile, the nullifier
/// and commitment maps, the field checks and the leaf bound. That is the
/// property worth proving, because it is the one that does not depend on a
/// circuit review to be true (the ZIP-209 reasoning in `ShieldedPool.sol`).
///
/// The cost of that choice is that the handler can reach states an honest client
/// never would. Where a state is unreachable through a real verifier, it is
/// noted at the call site rather than quietly avoided.
contract PoolHandler is Test {
    ShieldedPool public pool;

    /// Native plus two ERC-20s. Two is enough to prove the turnstile is per
    /// token rather than global, which one token cannot show.
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    uint256[3] public tokenIds;

    address constant RECIPIENT = address(0xB0B);
    address constant RELAYER = address(0xFEE);

    // ------------------------------------------------------- shadow ledger ---

    mapping(uint256 => uint256) public ghostInflow;
    mapping(uint256 => uint256) public ghostOutflow;

    /// Every root the pool has advanced to, oldest first, starting with the
    /// empty root written in the constructor.
    bytes32[] public rootsAdvanced;

    bytes32[] public nullifiersUsed;
    bytes32[] public commitmentsUsed;
    mapping(bytes32 => bool) internal seenNullifier;
    mapping(bytes32 => bool) internal seenCommitment;

    /// Set if the pool ever accepted a nullifier or commitment it had already
    /// accepted. Nothing in the suite ever clears these.
    bool public nullifierAcceptedTwice;
    bool public commitmentAcceptedTwice;

    uint32 public highWaterLeafIndex;
    bool public leafIndexWentBackwards;

    /// One leaf per accepted deposit, two per accepted spend. Compared against
    /// the pool's own counter, this catches a stalled index as well as a
    /// rewound one — a stall is the worse bug of the two, because it hands the
    /// next insertion a position the tree already occupies.
    uint256 public expectedLeafIndex;

    // Call counters, so a run that quietly reverted everything is visible
    // rather than passing as a vacuous green.
    uint256 public shieldsAccepted;
    uint256 public spendsAccepted;
    uint256 public turnstileBlocks;
    uint256 public replaysBlocked;
    uint256 public staleRootBlocks;

    uint256 internal nonce;

    constructor(ShieldedPool _pool) {
        pool = _pool;
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        tokenIds[0] = 0;
        tokenIds[1] = uint256(uint160(address(tokenA)));
        tokenIds[2] = uint256(uint160(address(tokenB)));
        rootsAdvanced.push(pool.EMPTY_ROOT());
    }

    /// Field elements the pool will accept. Shifting off the top byte lands
    /// every value below 2^248, comfortably inside BN254 Fr, and the nonce makes
    /// each one distinct — which is what a real circuit guarantees about roots
    /// and commitments and what this handler therefore reproduces.
    function _fresh() internal returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode("cowl-invariant", nonce++))) >> 8);
    }

    /// Runs after every action: leaf index is read straight off the pool, so a
    /// regression shows up even if the action itself reverted.
    modifier record() {
        _;
        uint32 nli = pool.nextLeafIndex();
        if (nli < highWaterLeafIndex) leafIndexWentBackwards = true;
        highWaterLeafIndex = nli;
    }

    function _noteCommitment(bytes32 c) internal {
        if (seenCommitment[c]) commitmentAcceptedTwice = true;
        seenCommitment[c] = true;
        commitmentsUsed.push(c);
    }

    function _noteNullifier(bytes32 n) internal {
        if (seenNullifier[n]) nullifierAcceptedTwice = true;
        seenNullifier[n] = true;
        nullifiersUsed.push(n);
    }

    // -------------------------------------------------------------- actions ---

    function shieldNative(uint256 valueSeed) external record {
        uint256 value = bound(valueSeed, 1, 100 ether);
        bytes32 commitment = _fresh();
        bytes32 newRoot = _fresh();
        vm.deal(address(this), value);
        try pool.shield{value: value}(0, value, commitment, newRoot, okCipher(), "") {
            shieldsAccepted++;
            ghostInflow[0] += value;
            _noteCommitment(commitment);
            rootsAdvanced.push(newRoot);
            expectedLeafIndex += 1;
        } catch {}
    }

    function shieldToken(uint256 tokenSeed, uint256 valueSeed) external record {
        uint256 pick = bound(tokenSeed, 1, 2);
        uint256 token = tokenIds[pick];
        uint256 value = bound(valueSeed, 1, 1_000_000e18);
        bytes32 commitment = _fresh();
        bytes32 newRoot = _fresh();
        MockERC20(address(uint160(token))).mint(address(this), value);
        try pool.shield(token, value, commitment, newRoot, okCipher(), "") {
            shieldsAccepted++;
            ghostInflow[token] += value;
            _noteCommitment(commitment);
            rootsAdvanced.push(newRoot);
            expectedLeafIndex += 1;
        } catch {}
    }

    /// A spend that moves value out. `overshoot` deliberately asks for more than
    /// the token ever took in, which is the turnstile's whole job.
    function spendPayout(uint256 tokenSeed, uint256 valueSeed, uint256 feeSeed, bool overshoot)
        external
        record
    {
        uint256 token = tokenIds[bound(tokenSeed, 0, 2)];
        uint256 pooled = pool.pooledValue(token);

        uint256 value;
        uint256 fee;
        if (overshoot) {
            // Always strictly more than the pool holds for this token.
            value = pooled + 1 + bound(valueSeed, 0, 1 ether);
            fee = bound(feeSeed, 0, 1 ether);
        } else {
            if (pooled == 0) return;
            value = bound(valueSeed, 0, pooled);
            fee = bound(feeSeed, 0, pooled - value);
        }

        ShieldedPool.Spend memory s = _spendStruct(token, value, fee);
        try pool.spend(s, okCiphers(), "") {
            spendsAccepted++;
            ghostOutflow[token] += value + fee;
            _accept(s);
        } catch (bytes memory err) {
            if (bytes4(err) == ShieldedPool.ExceedsPooledValue.selector) turnstileBlocks++;
        }
    }

    /// Value zero, fee zero. Nothing leaves, so `token` is unconstrained by the
    /// circuit and the pool ignores it. Proves the accounting stays untouched.
    function spendPrivate(uint256 tokenSeed) external record {
        uint256 token = tokenIds[bound(tokenSeed, 0, 2)];
        ShieldedPool.Spend memory s = _spendStruct(token, 0, 0);
        try pool.spend(s, okCiphers(), "") {
            spendsAccepted++;
            _accept(s);
        } catch {}
    }

    /// Reuse a nullifier the pool has already burned. Must never be accepted.
    function replayNullifier(uint256 idxSeed, uint256 tokenSeed) external record {
        if (nullifiersUsed.length == 0) return;
        bytes32 used = nullifiersUsed[bound(idxSeed, 0, nullifiersUsed.length - 1)];
        uint256 token = tokenIds[bound(tokenSeed, 0, 2)];

        ShieldedPool.Spend memory s = _spendStruct(token, 0, 0);
        s.nullifiers[0] = used;
        try pool.spend(s, okCiphers(), "") {
            // The pool accepted a burned nullifier. Recorded, not thrown, so the
            // invariant reports it with the full failing sequence attached.
            spendsAccepted++;
            nullifierAcceptedTwice = true;
            _accept(s);
        } catch {
            replaysBlocked++;
        }
    }

    /// Reuse a commitment the pool has already inserted. Must never be accepted.
    function replayCommitment(uint256 idxSeed, uint256 tokenSeed) external record {
        if (commitmentsUsed.length == 0) return;
        bytes32 used = commitmentsUsed[bound(idxSeed, 0, commitmentsUsed.length - 1)];
        uint256 token = tokenIds[bound(tokenSeed, 0, 2)];

        ShieldedPool.Spend memory s = _spendStruct(token, 0, 0);
        s.commitments[0] = used;
        try pool.spend(s, okCiphers(), "") {
            spendsAccepted++;
            commitmentAcceptedTwice = true;
            _accept(s);
        } catch {
            replaysBlocked++;
        }
    }

    /// Prove membership against a root the ring has evicted. Must never be
    /// accepted: a root outside the window is not spendable however old the
    /// note behind it is.
    function spendAgainstEvictedRoot(uint256 idxSeed, uint256 tokenSeed) external record {
        if (rootsAdvanced.length == 0) return;
        bytes32 old = rootsAdvanced[bound(idxSeed, 0, rootsAdvanced.length - 1)];
        if (pool.knownRoot(old)) return; // still inside the window, nothing to prove
        uint256 token = tokenIds[bound(tokenSeed, 0, 2)];

        ShieldedPool.Spend memory s = _spendStruct(token, 0, 0);
        s.membershipRoot = old;
        try pool.spend(s, okCiphers(), "") {
            spendsAccepted++;
            _accept(s);
        } catch {
            staleRootBlocks++;
        }
    }

    /// Native value arriving without a deposit. Nothing about the pool's
    /// accounting may move.
    function forceFeedNative(uint256 amountSeed) external record {
        uint256 amount = bound(amountSeed, 1, 10 ether);
        vm.deal(address(this), amount);
        new Bomb{value: amount}(payable(address(pool)));
    }

    function proposeVerifierSwap(bool shieldKind) external record {
        ShieldedPool.VerifierKind kind =
            shieldKind ? ShieldedPool.VerifierKind.Shield : ShieldedPool.VerifierKind.Transfer;
        // Owner is the test contract that deployed the pool, not the handler, so
        // this is the unauthorised path and must revert every time.
        try pool.proposeVerifierSwap(kind, pool.shieldVerifier()) {} catch {}
    }

    // ------------------------------------------------------------ internals ---

    function _spendStruct(uint256 token, uint256 value, uint256 fee)
        internal
        returns (ShieldedPool.Spend memory s)
    {
        s.membershipRoot = pool.root();
        s.nullifiers[0] = _fresh();
        s.nullifiers[1] = _fresh();
        s.commitments[0] = _fresh();
        s.commitments[1] = _fresh();
        s.newRoot = _fresh();
        s.token = token;
        s.value = value;
        s.fee = fee;
        s.recipient = RECIPIENT;
        s.relayer = RELAYER;
    }

    function _accept(ShieldedPool.Spend memory s) internal {
        _noteNullifier(s.nullifiers[0]);
        _noteNullifier(s.nullifiers[1]);
        _noteCommitment(s.commitments[0]);
        _noteCommitment(s.commitments[1]);
        rootsAdvanced.push(s.newRoot);
        expectedLeafIndex += 2;
    }

    // --------------------------------------------------------- ledger reads ---

    function tokenCount() external pure returns (uint256) {
        return 3;
    }

    function tokenAt(uint256 i) external view returns (uint256) {
        return tokenIds[i];
    }

    function rootCount() external view returns (uint256) {
        return rootsAdvanced.length;
    }

    function rootAt(uint256 i) external view returns (bytes32) {
        return rootsAdvanced[i];
    }

    function nullifierCount() external view returns (uint256) {
        return nullifiersUsed.length;
    }

    function commitmentCount() external view returns (uint256) {
        return commitmentsUsed.length;
    }

    receive() external payable {}
}
