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

// The compiled join-split (`transfer`) circuit — the one spend circuit for the
// whole pool: it consumes up to two notes and produces exactly two, optionally
// paying a public leg out. Embedded for the same reason as SHIELD_CIRCUIT above.
//
// Regenerate with `nargo compile --package transfer` in cli/circuits, then copy
// noir_version / hash / abi / bytecode across. The hash pins which circuit this is:
// it must stay in step with the verifying key baked into the deployed
// TransferVerifier, or every proof this produces is rejected on chain.
//
//   public:  membership_root, nullifiers[2], out_commitments[2], old_root,
//            new_root, insert_index, public_token, public_value, fee,
//            recipient, relayer   (the order ShieldedPool.spend passes them)
//   private: sk, token, in_{value,blinding,leaf_index,path,right}[2],
//            out_{mpk,value,blinding,path,right}[2]

export const TRANSFER_CIRCUIT = {
    "noir_version": "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7",
    "hash": "2709994343485431488",
    "abi": {
        "parameters": [
            {
                "name": "sk",
                "type": {
                    "kind": "field"
                },
                "visibility": "private"
            },
            {
                "name": "token",
                "type": {
                    "kind": "field"
                },
                "visibility": "private"
            },
            {
                "name": "in_value",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "in_blinding",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "in_leaf_index",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "in_path",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "array",
                        "length": 20,
                        "type": {
                            "kind": "field"
                        }
                    }
                },
                "visibility": "private"
            },
            {
                "name": "in_right",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "array",
                        "length": 20,
                        "type": {
                            "kind": "boolean"
                        }
                    }
                },
                "visibility": "private"
            },
            {
                "name": "out_mpk",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "out_value",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "out_blinding",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "private"
            },
            {
                "name": "out_path",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "array",
                        "length": 20,
                        "type": {
                            "kind": "field"
                        }
                    }
                },
                "visibility": "private"
            },
            {
                "name": "out_right",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "array",
                        "length": 20,
                        "type": {
                            "kind": "boolean"
                        }
                    }
                },
                "visibility": "private"
            },
            {
                "name": "membership_root",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "nullifiers",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
                },
                "visibility": "public"
            },
            {
                "name": "out_commitments",
                "type": {
                    "kind": "array",
                    "length": 2,
                    "type": {
                        "kind": "field"
                    }
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
                "name": "insert_index",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "public_token",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "public_value",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "fee",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "recipient",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            },
            {
                "name": "relayer",
                "type": {
                    "kind": "field"
                },
                "visibility": "public"
            }
        ],
        "return_type": null,
        "error_types": {
            "1066744642700416338": {
                "error_kind": "string",
                "string": "value is not conserved"
            },
            "1932671243860007697": {
                "error_kind": "string",
                "string": "leaf index contradicts path"
            },
            "4418699879549947501": {
                "error_kind": "string",
                "string": "input note is not under this root"
            },
            "10269837725332973741": {
                "error_kind": "string",
                "string": "outputs are not appended in order"
            },
            "12027420794153852110": {
                "error_kind": "string",
                "string": "public leg does not match the note asset"
            },
            "12469291177396340830": {
                "error_kind": "string",
                "string": "call to assert_max_bit_size"
            },
            "13194601656333571327": {
                "error_kind": "string",
                "string": "new root does not follow from the insertions"
            },
            "16475824768229734907": {
                "error_kind": "string",
                "string": "output path does not match the current tree"
            }
        }
    },
    "bytecode": "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"
} as const;

/** Noir toolchain this circuit was compiled with. Pinned in package.json too. */
export const TRANSFER_NOIR_VERSION = "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7";
