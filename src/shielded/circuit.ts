// The compiled `shield` circuit, embedded rather than shipped as a separate asset:
// the bytecode is small enough that inlining it keeps the CLI a single bundled file
// and removes any chance of the artifact going missing at runtime.
//
// Regenerate with `nargo compile --package shield` in cli/circuits, then copy
// noir_version / hash / abi / bytecode across. The hash below pins which circuit
// this is: it must stay in step with the verifying key baked into the deployed
// ShieldVerifier, or every proof this produces will be rejected on chain.
//
//   commitment = Poseidon2(mpk, token, value, blinding)
//   inserting it at leaf_index turns old_root into new_root
//
//   public:  token, value, commitment, old_root, new_root, leaf_index
//   private: mpk, blinding, insert_path, insert_right

export const SHIELD_CIRCUIT = {
    "noir_version": "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7",
    "hash": "17633779987464218860",
    "abi": {
      "parameters": [
        {
          "name": "mpk",
          "type": {
            "kind": "field"
          },
          "visibility": "private"
        },
        {
          "name": "blinding",
          "type": {
            "kind": "field"
          },
          "visibility": "private"
        },
        {
          "name": "insert_path",
          "type": {
            "kind": "array",
            "length": 20,
            "type": {
              "kind": "field"
            }
          },
          "visibility": "private"
        },
        {
          "name": "insert_right",
          "type": {
            "kind": "array",
            "length": 20,
            "type": {
              "kind": "boolean"
            }
          },
          "visibility": "private"
        },
        {
          "name": "token",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        },
        {
          "name": "value",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        },
        {
          "name": "commitment",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        },
        {
          "name": "old_root",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        },
        {
          "name": "new_root",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        },
        {
          "name": "leaf_index",
          "type": {
            "kind": "field"
          },
          "visibility": "public"
        }
      ],
      "return_type": null,
      "error_types": {
        "4949432764338249425": {
          "error_kind": "string",
          "string": "insertion path does not match the current tree"
        },
        "10872454413905019788": {
          "error_kind": "string",
          "string": "new root does not follow from the insertion"
        },
        "17614067446231984554": {
          "error_kind": "string",
          "string": "leaf index contradicts the insertion path"
        }
      }
    },
    "bytecode": "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"
  } as const;

/** Noir toolchain this circuit was compiled with. Pinned in package.json too. */
export const SHIELD_NOIR_VERSION = "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7";
