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
//   public: token, value, commitment    private: mpk, blinding

export const SHIELD_CIRCUIT = {
    "noir_version": "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7",
    "hash": "4321950125537484127",
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
        }
      ],
      "return_type": null,
      "error_types": {}
    },
    "bytecode": "H4sIAAAAAAAA/52PPQuCQByHz7T3l8/QWFsvn6CiaAq3ImiQvEHSu/AUarxvoKc1NwRBU0NE7X4Rt8aW9iYPhELpNz3Dnz/PIzJ3fzQUDe3ouUcINK05NLHnuCyot9SJGbYPzbs8vFE6WzS6z/H2sXYH4dt7AQCyQR18nxQBvfR1Zbnq483IRsuBouv0KmMCNRWjjgxNw7YUS8OI+fQ01SwECQGcMpxETlk/ly8U464e+ykSTRBS3ORSNJcS3/zTXOKU51TgVPTLlWot3sxSuEopmsvJPQwIXkaUHMf5AE3QCPMtAgAA"
  } as const;

/** Noir toolchain this circuit was compiled with. Pinned in package.json too. */
export const SHIELD_NOIR_VERSION = "1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7";
