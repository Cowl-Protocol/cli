#!/usr/bin/env bash
# Redeploy the shielded pool + both verifiers to Robinhood Chain testnet (46630).
# Prompts for the cowl-deployer keystore password. From cli/contracts:
#   bash deploy-testnet.sh
set -euo pipefail
cd "$(dirname "$0")"
forge script script/Deploy.s.sol \
  --rpc-url https://46630.rpc.thirdweb.com \
  --account cowl-deployer \
  --broadcast
