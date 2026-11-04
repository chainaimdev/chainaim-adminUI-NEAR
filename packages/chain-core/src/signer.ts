/**
 * The signer seam (interface only). Nothing in near-watch signs: it only reads the chain.
 *
 * Step 4 (DESIGN §8): services/custody implements this against OutLayer Agent Custody (`/wallet/v1/call`), keys
 * derived and used inside Intel TDX, so an agent tenant holds only an API key. The paywall's buyer scripts use the
 * same shape for their dev signer, so swapping the dev signer for the TEE one changes no payment code.
 */

/**
 * One NEP-141 transfer the caller wants made, amount in base units. No memo: the x402 NEAR exact scheme's transfer is
 * `ft_transfer {receiver_id, amount}` (chainiam-private-ai docs/NEAR-GATES.md G3), so the invoice never goes on chain.
 */
export type FtTransferRequest = {
  contractId: string;
  receiverId: string;
  amount: string;
  /** ft_transfer requires exactly 1 yoctoNEAR attached (NEP-141); gas in gas units. */
  gas: string;
};

export type SignedTransfer = {
  /** Base58 transaction hash. */
  hash: string;
  /** Borsh-serialized signed transaction, base64; submitted only after the paid call succeeded. */
  signedTransactionBase64: string;
};

export interface NearSigner {
  readonly accountId: string;
  readonly publicKey: string;
  /** Build and sign, never submit. */
  signFtTransfer(req: FtTransferRequest): Promise<SignedTransfer>;
}
