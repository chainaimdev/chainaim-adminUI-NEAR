# services/custody (step 4, deferred, not built)

This service will hold OutLayer TEE wallets for agent tenants (DESIGN §8). It will implement the `NearSigner` interface in `packages/chain-core/src/signer.ts` by calling OutLayer Agent Custody `/wallet/v1/call` (testnet base `https://testnet-api.outlayer.ai`). With that interface in place, the paywall's buyer scripts can swap their dev signer for the TEE one without changing any payment code.

Facts already verified (app.outlayer.ai/docs/agent-custody):
- An agent holds only an API key (`wk_…`).
- Key derivation, signing and policy checks run inside Intel TDX.
- `POST /register` returns `api_key` and an implicit `near_account_id`.
- Cumulative caps are best-effort under concurrency, so agent payments must be serialized.

There is no code here yet, by design.
