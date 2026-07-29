// The join-split circuit — the one spend circuit for the whole pool.
//
// It consumes up to two notes already in the tree and produces exactly two new
// ones, optionally paying part of the value out to a public address. That single
// shape covers every spend Cowl needs:
//
//   send      two private output legs, public_value = 0
//   unshield  one public output leg, the change note stays private
//   split     one input, two outputs to different owners (revenue-split)
//
// One circuit instead of three means one verifying key, one audit, one place for
// a conservation bug to hide.
//
// What the chain learns from a spend: two roots, two nullifiers, two opaque
// commitments, and — only when value actually leaves — the public amount, token,
// and destination. Amounts, tokens and owners of the private legs stay hidden.
//
// Two different roots appear here, and the difference matters:
//
//   membership_root  any root the contract still remembers. Input notes are
//                    proven against it, so a spend does not go stale the moment
//                    someone else's deposit moves the tree.
//   old_root         the contract's current root, the one the outputs are
//                    appended to. Must be today's, or the new root would be
//                    computed over a tree that no longer exists.
//
// Spec parity with the client lives in circuits/notes (see cli/src/shielded/).
use notes::{commit, derive_keys, insert, nullify, walk, TREE_DEPTH, VALUE_BITS};
use poseidon::poseidon2::Poseidon2;

global N_IN: u32 = 2;
global N_OUT: u32 = 2;

fn main(
    // ---------------- private ----------------
    // Spending key. nk and mpk are derived from it in-circuit, so possession of
    // sk is what authorizes every input note — there is no separate signature.
    sk: Field,
    // The asset. Private: a pure note-to-note send should not reveal which token
    // moved. It becomes public only via `public_token`, and only when value
    // actually leaves the pool.
    token: Field,
    // Input notes. A slot with value 0 is a dummy: it funds nothing, and its
    // Merkle membership is not enforced, which is what lets a one-note spend use
    // the same two-input circuit as a two-note spend.
    in_value: [Field; N_IN],
    in_blinding: [Field; N_IN],
    in_leaf_index: [Field; N_IN],
    in_path: [[Field; TREE_DEPTH]; N_IN],
    // true = this node is the right child at that level, sibling on the left.
    in_right: [[bool; TREE_DEPTH]; N_IN],
    // Output notes. Always two, always appended — a zero-value output is
    // indistinguishable on chain from a funded one, so "how many legs did that
    // spend really have" leaks nothing.
    out_mpk: [Field; N_OUT],
    out_value: [Field; N_OUT],
    out_blinding: [Field; N_OUT],
    // Append paths for the two outputs, in order. The second is taken against
    // the tree the first one produced.
    out_path: [[Field; TREE_DEPTH]; N_OUT],
    out_right: [[bool; TREE_DEPTH]; N_OUT],
    // ---------------- public ----------------
    membership_root: pub Field,
    nullifiers: pub [Field; N_IN],
    out_commitments: pub [Field; N_OUT],
    old_root: pub Field,
    new_root: pub Field,
    // Leaf index of the first output; the second lands at insert_index + 1.
    insert_index: pub Field,
    // The public leg. public_value = 0 and fee = 0 means nothing leaves and this
    // is a pure internal spend; the contract then ignores public_token.
    public_token: pub Field,
    public_value: pub Field,
    // Paid to `relayer` in the same asset, so a gasless spend can compensate the
    // submitter out of shielded funds.
    fee: pub Field,
    recipient: pub Field,
    relayer: pub Field,
    // The deployment this spend is for. The contract passes block.chainid, so a
    // proof built for one chain cannot verify on another even though every
    // instance shares this verifying key — no cross-instance or fork replay.
    chain_id: pub Field,
) {
    let (nk, mpk) = derive_keys(sk);

    let mut sum_in: Field = 0;
    for i in 0..N_IN {
        let value = in_value[i];
        value.assert_max_bit_size::<VALUE_BITS>();

        // Zero-value notes carry nothing, so they are the natural dummy marker:
        // no in-circuit flag to forge, and no way to smuggle value through a
        // slot whose membership goes unchecked.
        let is_real = (value != 0) as Field;

        let commitment = commit(mpk, token, value, in_blinding[i]);
        let (root, index) = walk(commitment, in_path[i], in_right[i]);

        // Both checks are waived for a dummy — that is the whole point of a
        // dummy — so its leaf index stays free. The client fills it with a
        // random field element, which lands far outside the 0..2^20 range real
        // leaves occupy and therefore cannot burn a real note's nullifier.
        assert((root - membership_root) * is_real == 0, "input note is not under this root");
        assert((in_leaf_index[i] - index) * is_real == 0, "leaf index contradicts path");

        assert_eq(nullifiers[i], nullify(nk, in_leaf_index[i]));

        sum_in += value;
    }

    let mut sum_out: Field = 0;
    // Chained: each append starts from the root the previous one produced, so
    // the two outputs land in adjacent slots of the same tree.
    let mut root_cursor = old_root;
    for j in 0..N_OUT {
        let value = out_value[j];
        value.assert_max_bit_size::<VALUE_BITS>();
        assert_eq(out_commitments[j], commit(out_mpk[j], token, value, out_blinding[j]));
        sum_out += value;

        let (before, after, index) = insert(out_commitments[j], out_path[j], out_right[j]);
        assert(before == root_cursor, "output path does not match the current tree");
        assert(index == insert_index + j as Field, "outputs are not appended in order");
        root_cursor = after;
    }
    assert(root_cursor == new_root, "new root does not follow from the insertions");

    public_value.assert_max_bit_size::<VALUE_BITS>();
    fee.assert_max_bit_size::<VALUE_BITS>();

    // Whatever leaves has to be the same asset the notes hold, or a spend of
    // one token could withdraw the pool's balance of another. Enforced only when
    // something leaves, so a pure send leaves public_token unconstrained — and
    // therefore uninformative.
    assert(
        (public_value + fee) * (public_token - token) == 0,
        "public leg does not match the note asset",
    );

    assert(sum_in == sum_out + public_value + fee, "value is not conserved");

    // Bind the payout addresses and the chain id into the proof. Without this a
    // pending unshield is malleable: anyone watching the mempool could resubmit
    // the same proof with their own address in the calldata, and a proof could
    // be replayed on another instance of this circuit. Hashing them is what
    // holds the wires in the constraint system — a public input the circuit
    // never touches can be optimised away, and an optimised-away input binds
    // nothing.
    let payout_tag = Poseidon2::hash([recipient, relayer, chain_id], 3);
    assert(payout_tag != 0);
}

// ---------------------------------------------------------------------------
// Tests
//
// Witnesses are built with the same primitives the circuit uses, so these check
// structure — conservation, membership, append order, the dummy rule — not hash
// parity. Parity with the JS client is pinned in circuits/poseidon-parity, and
// end to end by the transfer parity script.
// ---------------------------------------------------------------------------

/// One note worth `in_value` sitting alone at leaf 0, spent into two outputs.
/// `bump` is added to output 0 so a test can break conservation deliberately.
struct Case {
    sk: Field,
    token: Field,
    in_value: Field,
    out_value: [Field; N_OUT],
    public_token: Field,
    public_value: Field,
    fee: Field,
}

fn run(c: Case) {
    let (nk, mpk) = derive_keys(c.sk);
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];

    // Tree holding just the input note at leaf 0.
    let input = commit(mpk, c.token, c.in_value, 11);
    let (_, membership_root, _) = insert(input, zeros, flat);

    let out_commitments = [
        commit(mpk, c.token, c.out_value[0], 21),
        commit(0x999, c.token, c.out_value[1], 22),
    ];

    // Outputs append at leaves 1 and 2. Their paths are derived by walking the
    // tree forward, which is exactly what the client does.
    let (path1, right1) = append_path_1(input);
    let (_, mid_root, _) = insert(out_commitments[0], path1, right1);
    let (path2, right2) = append_path_2(input, out_commitments[0]);
    let (_, new_root, _) = insert(out_commitments[1], path2, right2);
    assert_eq(mid_root, walk(out_commitments[0], path1, right1).0);

    let dummy_index = 0x1234567890abcdef;

    main(
        c.sk,
        c.token,
        [c.in_value, 0],
        [11, 12],
        [0, dummy_index],
        [zeros, zeros],
        [flat, flat],
        [mpk, 0x999],
        c.out_value,
        [21, 22],
        [path1, path2],
        [right1, right2],
        membership_root,
        [nullify(nk, 0), nullify(nk, dummy_index)],
        out_commitments,
        membership_root,
        new_root,
        1,
        c.public_token,
        c.public_value,
        c.fee,
        0xbeef,
        0xcafe,
        46630,
    );
}

/// Path for leaf 1 of a tree whose only leaf is `leaf0`: sibling at level 0 is
/// leaf0 itself, everything above is an empty subtree.
fn append_path_1(leaf0: Field) -> ([Field; TREE_DEPTH], [bool; TREE_DEPTH]) {
    let mut path = notes::zeros_path();
    path[0] = leaf0;
    let mut right = [false; TREE_DEPTH];
    right[0] = true;
    (path, right)
}

/// Path for leaf 2, which opens a fresh pair. Index 2 is bits (0, 1): left child
/// at level 0 with an empty sibling, right child at level 1 with the node over
/// leaves 0 and 1 on its left.
fn append_path_2(leaf0: Field, leaf1: Field) -> ([Field; TREE_DEPTH], [bool; TREE_DEPTH]) {
    let mut path = notes::zeros_path();
    path[1] = Poseidon2::hash([leaf0, leaf1], 2);
    let mut right = [false; TREE_DEPTH];
    right[1] = true;
    (path, right)
}

#[test]
fn send_keeps_value_inside_the_pool() {
    run(Case { sk: 7, token: 0, in_value: 100, out_value: [60, 40], public_token: 0, public_value: 0, fee: 0 });
}

#[test(should_fail_with = "value is not conserved")]
fn send_cannot_mint_value() {
    run(Case { sk: 7, token: 0, in_value: 100, out_value: [61, 40], public_token: 0, public_value: 0, fee: 0 });
}

/// The point of leaving `public_token` unconstrained: a pure send may set it to
/// zero and say nothing about which asset moved. Every test above sends a note
/// whose token is already 0, so none of them could tell a free field from a
/// forced one — this one holds a real asset and still names nothing.
#[test]
fn send_need_not_name_its_asset() {
    run(Case { sk: 7, token: 0x1111, in_value: 100, out_value: [60, 40], public_token: 0, public_value: 0, fee: 0 });
}

/// And the price of paying a relayer out of the same notes: the moment a fee
/// leaves, the asset is pinned to what the notes hold, so a gasless send cannot
/// also be an anonymous one. This is the constraint, not a client choice.
#[test(should_fail_with = "public leg does not match the note asset")]
fn a_paid_send_cannot_hide_its_asset() {
    run(Case { sk: 7, token: 0x1111, in_value: 100, out_value: [60, 35], public_token: 0, public_value: 0, fee: 5 });
}

#[test]
fn unshield_pays_out_and_keeps_change() {
    run(Case { sk: 7, token: 0x1111, in_value: 100, out_value: [30, 0], public_token: 0x1111, public_value: 65, fee: 5 });
}

#[test(should_fail_with = "public leg does not match the note asset")]
fn unshield_cannot_withdraw_a_different_token() {
    run(Case { sk: 7, token: 0x1111, in_value: 100, out_value: [0, 0], public_token: 0x2222, public_value: 100, fee: 0 });
}

#[test(should_fail)]
fn output_value_cannot_wrap_the_field() {
    // Conservation holds in the field — 100 = huge + (100 - huge) — but the
    // range check on every leg is what makes that unreachable.
    let huge = 0 - 1;
    run(Case { sk: 7, token: 0, in_value: 100, out_value: [huge, 100 - huge], public_token: 0, public_value: 0, fee: 0 });
}

#[test(should_fail_with = "input note is not under this root")]
fn cannot_spend_a_note_that_is_not_in_the_tree() {
    let sk = 7;
    let (nk, mpk) = derive_keys(sk);
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];

    // A root over a note the spender does not hold.
    let (_, membership_root, _) = insert(commit(mpk, 0, 1, 11), zeros, flat);

    let out_commitments = [commit(mpk, 0, 100, 21), commit(mpk, 0, 0, 22)];
    let (path1, right1) = append_path_1(commit(mpk, 0, 1, 11));
    let (_, _, _) = insert(out_commitments[0], path1, right1);
    let (path2, right2) = append_path_2(commit(mpk, 0, 1, 11), out_commitments[0]);
    let (_, mid, _) = insert(out_commitments[0], path1, right1);
    let (_, new_root, _) = insert(out_commitments[1], path2, right2);
    assert(mid != new_root);

    main(
        sk,
        0,
        [100, 0],
        [11, 12],
        [0, 0xdead],
        [zeros, zeros],
        [flat, flat],
        [mpk, mpk],
        [100, 0],
        [21, 22],
        [path1, path2],
        [right1, right2],
        membership_root,
        [nullify(nk, 0), nullify(nk, 0xdead)],
        out_commitments,
        membership_root,
        new_root,
        1,
        0,
        0,
        0,
        0xbeef,
        0xcafe,
        46630,
    );
}

#[test(should_fail_with = "output path does not match the current tree")]
fn outputs_must_append_to_the_current_tree() {
    let sk = 7;
    let (nk, mpk) = derive_keys(sk);
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];
    let input = commit(mpk, 0, 100, 11);
    let (_, membership_root, _) = insert(input, zeros, flat);

    let out_commitments = [commit(mpk, 0, 100, 21), commit(mpk, 0, 0, 22)];
    let (path1, right1) = append_path_1(input);
    let (path2, right2) = append_path_2(input, out_commitments[0]);
    let (_, new_root, _) = insert(out_commitments[1], path2, right2);

    main(
        sk,
        0,
        [100, 0],
        [11, 12],
        [0, 0xdead],
        [zeros, zeros],
        [flat, flat],
        [mpk, mpk],
        [100, 0],
        [21, 22],
        [path1, path2],
        [right1, right2],
        membership_root,
        [nullify(nk, 0), nullify(nk, 0xdead)],
        out_commitments,
        0xdeadbeef, // an old_root the chain never had
        new_root,
        1,
        0,
        0,
        0,
        0xbeef,
        0xcafe,
        46630,
    );
}

#[test(should_fail)]
fn cannot_spend_someone_elses_note() {
    let victim_mpk = derive_keys(42).1;
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];
    let input = commit(victim_mpk, 0, 100, 11);
    let (_, membership_root, _) = insert(input, zeros, flat);

    let thief_sk = 7;
    let thief_nk = derive_keys(thief_sk).0;
    let out_commitments = [commit(victim_mpk, 0, 100, 21), commit(victim_mpk, 0, 0, 22)];
    let (path1, right1) = append_path_1(input);
    let (path2, right2) = append_path_2(input, out_commitments[0]);
    let (_, mid, _) = insert(out_commitments[0], path1, right1);
    let (_, new_root, _) = insert(out_commitments[1], path2, right2);
    assert(mid != new_root);

    main(
        thief_sk,
        0,
        [100, 0],
        [11, 12],
        [0, 0xdead],
        [zeros, zeros],
        [flat, flat],
        [victim_mpk, victim_mpk],
        [100, 0],
        [21, 22],
        [path1, path2],
        [right1, right2],
        membership_root,
        [nullify(thief_nk, 0), nullify(thief_nk, 0xdead)],
        out_commitments,
        membership_root,
        new_root,
        1,
        0,
        0,
        0,
        0xbeef,
        0xcafe,
        46630,
    );
}

// ---------------------------------------------------------------------------
// Two real inputs.
//
// Every case above spends one real note padded with a zero-value dummy, so the
// two-in arity — both inputs proven under the root, both nullified, conservation
// over their sum — never actually runs. These do: two notes at leaves 0 and 1
// consolidated into two outputs at leaves 2 and 3.
// ---------------------------------------------------------------------------

/// Two funded notes owned by `sk`, spent together into two private outputs.
struct Case2 {
    sk: Field,
    in_value: [Field; N_IN],
    out_value: [Field; N_OUT],
}

fn run2(c: Case2) {
    let (nk, mpk) = derive_keys(c.sk);
    let token = 0;
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];

    let in0 = commit(mpk, token, c.in_value[0], 101);
    let in1 = commit(mpk, token, c.in_value[1], 102);

    // membership_root = the tree holding both inputs. in1 appends onto the tree
    // that already holds in0, exactly as the chain grew it.
    let (path_app1, right_app1) = append_path_1(in0);
    let (_, membership_root, _) = insert(in1, path_app1, right_app1);

    // Membership paths against that root. in0 sits at leaf 0 (left everywhere,
    // sibling in1 at level 0); in1 at leaf 1 (right child at level 0, sibling in0).
    let mut path_in0 = zeros;
    path_in0[0] = in1;
    let mut path_in1 = zeros;
    path_in1[0] = in0;
    let mut right_in1 = flat;
    right_in1[0] = true;

    // Outputs append at leaves 2 and 3 of that same tree.
    let out0 = commit(mpk, token, c.out_value[0], 201);
    let out1 = commit(0x777, token, c.out_value[1], 202);
    let (path_out0, right_out0) = append_path_2(in0, in1);
    let (_, _, _) = insert(out0, path_out0, right_out0);
    let mut path_out1 = zeros;
    path_out1[0] = out0;
    path_out1[1] = Poseidon2::hash([in0, in1], 2);
    let mut right_out1 = flat;
    right_out1[0] = true;
    right_out1[1] = true;
    let (_, new_root, _) = insert(out1, path_out1, right_out1);

    main(
        c.sk,
        token,
        c.in_value,
        [101, 102],
        [0, 1],
        [path_in0, path_in1],
        [flat, right_in1],
        [mpk, 0x777],
        c.out_value,
        [201, 202],
        [path_out0, path_out1],
        [right_out0, right_out1],
        membership_root,
        [nullify(nk, 0), nullify(nk, 1)],
        [out0, out1],
        membership_root,
        new_root,
        2,
        0,
        0,
        0,
        0,
        0,
        46630,
    );
}

#[test]
fn two_real_inputs_consolidate_and_conserve() {
    run2(Case2 { sk: 9, in_value: [60, 40], out_value: [70, 30] });
}

#[test(should_fail_with = "value is not conserved")]
fn two_real_inputs_cannot_mint() {
    run2(Case2 { sk: 9, in_value: [60, 40], out_value: [70, 31] });
}

// ---------------------------------------------------------------------------
// Adversarial harness
//
// The tests above check that honest spends work and that a few obviously wrong
// ones do not. That is the easy direction. The class of bug that empties a
// shielded pool is the other one: a circuit that ACCEPTS a witness it should
// reject, because a constraint everyone assumed was there is missing.
//
// Fuzzing `main`'s inputs cannot find that. A random witness fails membership
// long before it reaches anything interesting, so the fuzzer only ever
// re-confirms that garbage is rejected. What finds it is a witness that is
// perfect in every respect except one, aimed at exactly one constraint.
//
// So every test below starts from `honest()`, bends a single field, and repairs
// anything downstream that the bend invalidated. If the circuit still accepts
// it, the constraint under test does not exist. That discipline is also what
// makes audits/circuits/mutants.sh meaningful: delete the paired constraint and
// the witness becomes fully valid, so the should_fail test starts passing and
// nargo reports it.
// ---------------------------------------------------------------------------

struct Witness {
    sk: Field,
    token: Field,
    in_value: [Field; N_IN],
    in_blinding: [Field; N_IN],
    in_leaf_index: [Field; N_IN],
    in_path: [[Field; TREE_DEPTH]; N_IN],
    in_right: [[bool; TREE_DEPTH]; N_IN],
    out_mpk: [Field; N_OUT],
    out_value: [Field; N_OUT],
    out_blinding: [Field; N_OUT],
    out_path: [[Field; TREE_DEPTH]; N_OUT],
    out_right: [[bool; TREE_DEPTH]; N_OUT],
    membership_root: Field,
    nullifiers: [Field; N_IN],
    out_commitments: [Field; N_OUT],
    old_root: Field,
    new_root: Field,
    insert_index: Field,
    public_token: Field,
    public_value: Field,
    fee: Field,
    recipient: Field,
    relayer: Field,
    chain_id: Field,
}

fn submit(w: Witness) {
    main(
        w.sk,
        w.token,
        w.in_value,
        w.in_blinding,
        w.in_leaf_index,
        w.in_path,
        w.in_right,
        w.out_mpk,
        w.out_value,
        w.out_blinding,
        w.out_path,
        w.out_right,
        w.membership_root,
        w.nullifiers,
        w.out_commitments,
        w.old_root,
        w.new_root,
        w.insert_index,
        w.public_token,
        w.public_value,
        w.fee,
        w.recipient,
        w.relayer,
        w.chain_id,
    );
}

/// A complete, valid spend: one note worth 100 at leaf 0 of a one-leaf tree,
/// split into two private outputs at leaves 1 and 2. The token is deliberately
/// non-zero so a test cannot pass by accident on a field that happens to be 0.
fn honest() -> Witness {
    let sk = 7;
    let token = 0x1111;
    let (nk, mpk) = derive_keys(sk);
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];

    let in_blinding = [11, 12];
    let input = commit(mpk, token, 100, in_blinding[0]);
    let membership_root = insert(input, zeros, flat).1;

    let out_mpk = [mpk, 0x999];
    let out_value = [60, 40];
    let out_blinding = [21, 22];
    let out_commitments = [
        commit(out_mpk[0], token, out_value[0], out_blinding[0]),
        commit(out_mpk[1], token, out_value[1], out_blinding[1]),
    ];

    let (path1, right1) = append_path_1(input);
    let (path2, right2) = append_path_2(input, out_commitments[0]);
    let new_root = insert(out_commitments[1], path2, right2).1;

    // A dummy's leaf index is unconstrained by design. The client fills it with
    // a random field element, far outside the 0..2^20 range real leaves occupy.
    let dummy_index = 0x1234567890abcdef;

    Witness {
        sk: sk,
        token: token,
        in_value: [100, 0],
        in_blinding: in_blinding,
        in_leaf_index: [0, dummy_index],
        in_path: [zeros, zeros],
        in_right: [flat, flat],
        out_mpk: out_mpk,
        out_value: out_value,
        out_blinding: out_blinding,
        out_path: [path1, path2],
        out_right: [right1, right2],
        membership_root: membership_root,
        nullifiers: [nullify(nk, 0), nullify(nk, dummy_index)],
        out_commitments: out_commitments,
        old_root: membership_root,
        new_root: new_root,
        insert_index: 1,
        public_token: 0,
        public_value: 0,
        fee: 0,
        recipient: 0xbeef,
        relayer: 0xcafe,
        chain_id: 46630,
    }
}

/// Rebuild the output commitments from whatever the output notes now say, then
/// repair the append paths and the new root. A test that rewrites an output can
/// call this and stay valid everywhere except where it meant to deviate.
fn recommit(w: Witness) -> Witness {
    let mut w = w;
    w.out_commitments = [
        commit(w.out_mpk[0], w.token, w.out_value[0], w.out_blinding[0]),
        commit(w.out_mpk[1], w.token, w.out_value[1], w.out_blinding[1]),
    ];
    reseal(w)
}

/// Repair the append paths and the new root for whatever `out_commitments`
/// currently holds. Assumes the input note at leaf 0 is unchanged.
fn reseal(w: Witness) -> Witness {
    let mut w = w;
    let mpk = derive_keys(w.sk).1;
    let input = commit(mpk, w.token, w.in_value[0], w.in_blinding[0]);
    let (path1, right1) = append_path_1(input);
    let (path2, right2) = append_path_2(input, w.out_commitments[0]);
    w.out_path = [path1, path2];
    w.out_right = [right1, right2];
    w.new_root = insert(w.out_commitments[1], path2, right2).1;
    w
}

/// The baseline must be accepted, or every should_fail below proves nothing:
/// a witness that was already invalid would be rejected whatever the circuit
/// did with the field under test.
#[test]
fn the_adversarial_baseline_is_a_valid_spend() {
    submit(honest());
}

// ------------------------------------------------------------ T3, the big one

/// Membership is proven from the path. The nullifier is computed from
/// `in_leaf_index`. Tie them together or the same note can be spent forever:
/// prove leaf 0, burn the nullifier for leaf 5, come back and burn leaf 6.
///
/// The witness below is valid in every other respect — the nullifier really is
/// the one for leaf 5 — so the only thing standing in its way is the constraint
/// this test is named for.
#[test(should_fail_with = "leaf index contradicts path")]
fn a_real_input_cannot_nullify_a_position_it_never_proved() {
    let mut w = honest();
    let nk = derive_keys(w.sk).0;
    w.in_leaf_index[0] = 5;
    w.nullifiers[0] = nullify(nk, 5);
    submit(w);
}

// ------------------------------------------------------------ T6, the mint

/// Conservation is checked over `out_value`. The leaf that enters the tree is
/// `out_commitments[j]`. Bind the two or the accounting sees 60 while the note
/// actually in the pool is worth a billion.
#[test(should_fail)]
fn an_output_note_cannot_be_worth_more_than_it_accounts_for() {
    let mut w = honest();
    // out_value stays [60, 40], so conservation is untouched. Only the leaf
    // changes, and the tree is resealed around it so the append and the new
    // root remain correct.
    w.out_commitments[0] = commit(w.out_mpk[0], w.token, 1_000_000_000, w.out_blinding[0]);
    submit(reseal(w));
}

// ------------------------------------------------------------ T4

/// The nullifier has to be the one this spending key produces for this leaf.
/// Otherwise a spender publishes a nullifier nobody can correlate, and the note
/// stays spendable after it has been spent.
#[test(should_fail)]
fn a_nullifier_must_be_the_one_this_key_produces() {
    let mut w = honest();
    w.nullifiers[0] = 0xdead;
    submit(w);
}

// ------------------------------------------------------------ T8, T9

/// The chain tells the circuit where the outputs land. If the circuit does not
/// hold the prover to it, the tree the pool believes it has and the tree the
/// proof built diverge, and every later membership proof is against a root
/// nobody can reproduce.
#[test(should_fail_with = "outputs are not appended in order")]
fn outputs_cannot_land_anywhere_but_the_index_the_chain_named() {
    let mut w = honest();
    w.insert_index = 5;
    submit(w);
}

/// `new_root` is what the pool stores. It has to be the root the insertions
/// actually produced, or a prover hands the pool a tree of their own design.
#[test(should_fail_with = "new root does not follow from the insertions")]
fn the_new_root_must_be_the_one_the_insertions_produce() {
    let mut w = honest();
    w.new_root = 0xdead;
    submit(w);
}

// ------------------------------------------------------------ T10, T11

/// Conservation is field arithmetic, so it can be satisfied by wrapping. Here
/// the outputs claim 200 against an input of 100 and the books are balanced
/// with a public leg of -100. In the field that adds up exactly. The range
/// check on the public leg is what makes it unreachable.
///
/// The pool's turnstile is the second line if it ever were reachable: it would
/// see an outflow of p-100 and refuse it against `pooledValue`.
#[test(should_fail)]
fn the_public_leg_cannot_wrap_the_field_to_mint_change() {
    let mut w = honest();
    w.out_value = [200, 0];
    w.public_value = 0 - 100;
    w.public_token = w.token; // value leaves, so the asset must be named
    submit(recommit(w));
}

/// The same wrap, through the fee instead of the payout.
#[test(should_fail)]
fn the_fee_cannot_wrap_the_field_to_mint_change() {
    let mut w = honest();
    w.out_value = [200, 0];
    w.fee = 0 - 100;
    w.public_token = w.token;
    submit(recommit(w));
}

// ------------------------------------------------------------ T1

/// Two inputs of -100 and 200 sum to 100 in the field, so conservation holds
/// while one input claims a value the pool never held. The range check on every
/// input is the only thing between that and a mint.
#[test(should_fail)]
fn an_input_cannot_wrap_the_field_to_fake_its_value() {
    submit(honest2([0 - 100, 200], [100, 0]));
}

/// And the honest version of the same shape, so the test above is known to fail
/// for its range check rather than because two real inputs never worked.
#[test]
fn two_real_inputs_of_ordinary_size_are_accepted() {
    submit(honest2([100, 200], [300, 0]));
}

/// Two funded notes at leaves 0 and 1, spent together into leaves 2 and 3.
fn honest2(in_value: [Field; N_IN], out_value: [Field; N_OUT]) -> Witness {
    let sk = 9;
    let token = 0x2222;
    let (nk, mpk) = derive_keys(sk);
    let zeros = notes::zeros_path();
    let flat = [false; TREE_DEPTH];

    let in_blinding = [101, 102];
    let in0 = commit(mpk, token, in_value[0], in_blinding[0]);
    let in1 = commit(mpk, token, in_value[1], in_blinding[1]);
    let (path_app1, right_app1) = append_path_1(in0);
    let membership_root = insert(in1, path_app1, right_app1).1;

    let mut path_in0 = zeros;
    path_in0[0] = in1;
    let mut path_in1 = zeros;
    path_in1[0] = in0;
    let mut right_in1 = flat;
    right_in1[0] = true;

    let out_mpk = [mpk, 0x777];
    let out_blinding = [201, 202];
    let out0 = commit(out_mpk[0], token, out_value[0], out_blinding[0]);
    let out1 = commit(out_mpk[1], token, out_value[1], out_blinding[1]);

    let (path_out0, right_out0) = append_path_2(in0, in1);
    let mut path_out1 = zeros;
    path_out1[0] = out0;
    path_out1[1] = Poseidon2::hash([in0, in1], 2);
    let mut right_out1 = flat;
    right_out1[0] = true;
    right_out1[1] = true;
    let new_root = insert(out1, path_out1, right_out1).1;

    Witness {
        sk: sk,
        token: token,
        in_value: in_value,
        in_blinding: in_blinding,
        in_leaf_index: [0, 1],
        in_path: [path_in0, path_in1],
        in_right: [flat, right_in1],
        out_mpk: out_mpk,
        out_value: out_value,
        out_blinding: out_blinding,
        out_path: [path_out0, path_out1],
        out_right: [right_out0, right_out1],
        membership_root: membership_root,
        nullifiers: [nullify(nk, 0), nullify(nk, 1)],
        out_commitments: [out0, out1],
        old_root: membership_root,
        new_root: new_root,
        insert_index: 2,
        public_token: 0,
        public_value: 0,
        fee: 0,
        recipient: 0,
        relayer: 0,
        chain_id: 46630,
    }
}

// ------------------------------------------------------- where the line is not

/// The circuit does not require the two input slots to be different notes.
///
/// Both slots below point at leaf 0 and spend the same note. Membership holds
/// twice, both slots nullify to the same value, and conservation happily sees
/// 200 come out of a note worth 100. **The circuit accepts this**, which is
/// what the test asserts.
///
/// `ShieldedPool.spend` is what refuses it: `nullifiers[0] == nullifiers[1]`
/// reverts with `RepeatedNullifier`, before the verifier is called at all. So
/// the property holds for the system as deployed, and this test records exactly
/// which half of the system holds it. If that contract check were ever removed
/// or reordered, this is a mint, and this test is the thing that says so.
#[test]
fn one_note_can_fill_both_input_slots_and_only_the_pool_says_no() {
    let mut w = honest();
    let nk = derive_keys(w.sk).0;
    w.in_value = [100, 100];
    w.in_blinding = [11, 11]; // the same note, twice
    w.in_leaf_index = [0, 0];
    w.nullifiers = [nullify(nk, 0), nullify(nk, 0)];
    w.out_value = [200, 0];
    submit(recommit(w));
}
