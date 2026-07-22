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

    // Bind the payout addresses into the proof. Without this a pending unshield
    // is malleable: anyone watching the mempool could resubmit the same proof
    // with their own address in the calldata. Hashing them is what holds the
    // wires in the constraint system — a public input the circuit never touches
    // can be optimised away, and an optimised-away input binds nothing.
    let payout_tag = Poseidon2::hash([recipient, relayer], 2);
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
    );
}
