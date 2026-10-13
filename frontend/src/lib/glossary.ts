/**
 * The few words a first-time visitor trips on, explained once. Every <Term>
 * in the app reads from here, so the same word never gets two definitions.
 */
export const GLOSSARY = {
  implied:
    "What the money on the market says the chance of Yes is. On a pooled market it is the Yes pool's share of all stakes; on an AMM market it is the current price of a Yes share.",
  strike:
    "The level the question is about. The market resolves Yes if the observed price is at or above it at expiry.",
  pool:
    "Pooled betting (parimutuel): every stake goes into one pot, and the winning side splits all of it in proportion to what each person put in. Your payout depends on the final pool, not on when you staked.",
  amm:
    "An automated market maker sells Yes and No shares at a price that moves with each trade. You lock your price when you buy, and can sell before expiry. Each winning share pays 1 mUSDC.",
  settlement:
    "After expiry a Chainlink network of ten nodes reads the real-world result, agrees on it, and writes it on chain. Nobody has to press anything.",
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;
