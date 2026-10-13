import { describe, expect, it } from "vitest";
import { derivePositions, deriveTraders } from "./useChainData";
import {
  MarketStatus,
  Outcome,
  type LpEvent,
  type Market,
  type TradeEvent,
} from "../lib/types";
import { amm0, crypto0, flight0, stock0 } from "../lib/fixtures";

/**
 * Portfolio and leaderboard derivation.
 *
 * Both walk stakes against markets, and both must key off the composite market
 * key. Market ids restart at zero in every contract, so keying by id would let
 * a stake on flight 0 pay out against crypto 0 — a wrong balance shown to a
 * user about their own money.
 */

const alice = "0x00000000000000000000000000000000000a11ce" as const;
const bob = "0x0000000000000000000000000000000000000b0b" as const;

const stake = (marketKey: string, user: string, isYes: boolean, amount: bigint): TradeEvent => ({
  marketKey,
  user: user as `0x${string}`,
  isYes,
  amount,
  blockNumber: 1n,
  txHash: `0x${"0".repeat(64)}`,
});

const resolved = (m: Market, outcome: Outcome, yesPool: bigint, noPool: bigint): Market =>
  ({
    ...m,
    status: outcome === Outcome.Void ? MarketStatus.Void : MarketStatus.Settled,
    outcome,
    yesPool,
    noPool,
  }) as Market;

describe("derivePositions", () => {
  it("attaches each stake to its own market when ids collide", () => {
    const markets = [flight0, crypto0, stock0];
    const stakes = new Map([
      [flight0.key, { yes: 1_000_000n, no: 0n, claimed: false }],
      [stock0.key, { yes: 0n, no: 5_000_000n, claimed: false }],
    ]);

    const positions = derivePositions(markets, stakes);

    expect(positions).toHaveLength(2);
    expect(positions.map((p) => p.market.key).sort()).toEqual([flight0.key, stock0.key]);
    // The crypto market shares flight's numeric id and must not pick up its stake.
    expect(positions.find((p) => p.market.categoryId === "crypto")).toBeUndefined();
    expect(positions.find((p) => p.market.key === stock0.key)?.no).toBe(5_000_000n);
  });

  it("skips markets the wallet never staked on", () => {
    const stakes = new Map([[flight0.key, { yes: 0n, no: 0n, claimed: false }]]);
    expect(derivePositions([flight0], stakes)).toHaveLength(0);
  });

  /**
   * Claiming must not erase the record of having won. `claimable` goes to zero
   * because there is nothing left to collect, but `entitlement` is what P&L is
   * measured against — netting off claimed positions reported a winning wallet
   * as flat.
   */
  it("keeps entitlement after a claim, while claimable drops to zero", () => {
    const m = resolved(flight0, Outcome.Yes, 1_000_000n, 3_000_000n);
    const stakes = new Map([[m.key, { yes: 1_000_000n, no: 0n, claimed: true }]]);

    const [p] = derivePositions([m], stakes);

    expect(p!.status).toBe("Claimed");
    expect(p!.claimable).toBe(0n);
    expect(p!.entitlement).toBe(4_000_000n);
  });

  it("labels a losing position Lost, not Open", () => {
    const m = resolved(flight0, Outcome.No, 1_000_000n, 3_000_000n);
    const stakes = new Map([[m.key, { yes: 1_000_000n, no: 0n, claimed: false }]]);
    const [p] = derivePositions([m], stakes);
    expect(p!.status).toBe("Lost");
    expect(p!.claimable).toBe(0n);
  });

  it("labels a void position Refundable even though the market never resolved", () => {
    const m = resolved(crypto0, Outcome.Void, 1_000_000n, 1_000_000n);
    const stakes = new Map([[m.key, { yes: 1_000_000n, no: 0n, claimed: false }]]);
    const [p] = derivePositions([m], stakes);
    expect(p!.status).toBe("Refundable");
    expect(p!.claimable).toBe(1_000_000n);
  });

  it("distinguishes awaiting settlement from still open", () => {
    const stakes = new Map([[flight0.key, { yes: 1_000_000n, no: 0n, claimed: false }]]);
    expect(derivePositions([flight0], stakes)[0]!.status).toBe("Open");

    const requested = { ...flight0, status: MarketStatus.SettlementRequested } as Market;
    expect(derivePositions([requested], stakes)[0]!.status).toBe("Awaiting settlement");
  });
});

describe("derivePositions — cost basis", () => {
  const ammMarket = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;

  const held = (yes: bigint, no: bigint, claimed = false) =>
    new Map([[ammMarket.key, { yes, no, claimed }]]);

  const trade = (
    direction: "buy" | "sell",
    collateral: bigint,
    shares: bigint,
    block = 1n,
    fee = 0n,
  ): TradeEvent => ({
    ...stake(ammMarket.key, alice, true, collateral),
    blockNumber: block,
    amm: { direction, shares, fee },
  });

  /** One deposit, as the chain reports it back through `lpPosition`. */
  const provided = (
    shares: bigint,
    totalShares: bigint,
    claimable: bigint,
    withdrawn = false,
  ) => new Map([[ammMarket.key, { shares, totalShares, withdrawn, claimable }]]);

  const deposit = (
    provider: `0x${string}`,
    amount: bigint,
    lpShares: bigint,
    totalLpShares: bigint,
    block = 0n,
  ): LpEvent => ({
    marketKey: ammMarket.key,
    provider,
    direction: "add",
    amount,
    lpShares,
    totalLpShares,
    blockNumber: block,
    txHash: "0x00",
  });

  /**
   * For a parimutuel market the stake IS the cost, so nothing changes.
   */
  it("uses the stake itself for a parimutuel position", () => {
    const m = resolved(flight0, Outcome.Yes, 1_000_000n, 3_000_000n);
    const stakes = new Map([[m.key, { yes: 1_000_000n, no: 0n, claimed: false }]]);
    expect(derivePositions([m], stakes)[0]!.cost).toBe(1_000_000n);
  });

  /**
   * For an AMM they are different quantities in different units. Using shares
   * as the cost made a winning position score zero — entitlement compared
   * against itself — and overstated the money at risk by roughly double.
   */
  it("uses collateral paid, not shares held, for an AMM position", () => {
    const trades = [trade("buy", 3_000_000n, 5_307_692n)];
    const [p] = derivePositions([ammMarket], held(5_307_692n, 0n), trades, alice);

    expect(p!.cost).toBe(3_000_000n);
    expect(p!.entitlement).toBe(5_307_692n);
    expect(p!.entitlement - p!.cost).toBe(2_307_692n);
  });

  it("nets a partial sale off the cost", () => {
    const trades = [
      trade("buy", 4_000_000n, 6_000_000n),
      trade("sell", 1_500_000n, 2_000_000n, 2n),
    ];
    const [p] = derivePositions([ammMarket], held(4_000_000n, 0n), trades, alice);
    expect(p!.cost).toBe(2_500_000n);
  });

  /** Somebody else's trades must never be priced into this wallet's position. */
  it("ignores trades by other wallets", () => {
    const mine = trade("buy", 3_000_000n, 5_000_000n);
    const theirs: TradeEvent = { ...trade("buy", 9_000_000n, 9_000_000n, 2n), user: bob };
    const [p] = derivePositions([ammMarket], held(5_000_000n, 0n), [mine, theirs], alice);
    expect(p!.cost).toBe(3_000_000n);
  });

  /**
   * A provider's position has no trade behind it. Depositing is their purchase
   * — it costs collateral and, when the pool is skewed, hands them shares of
   * their own — but emits no Bought event. Pricing that from trades alone
   * reported it as pure profit out of nothing.
   */
  it("charges a provider what they deposited, even with no trades at all", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    // Opened at 85%, so the provider kept YES and the pool took the rest.
    const [p] = derivePositions(
      [ammMarket],
      held(32_941_177n, 0n),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 7_058_823n),
    );

    expect(p!.cost).toBe(40_000_000n);
  });

  it("adds the deposit on top of the provider's own later trades", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const trades = [trade("buy", 10_000_000n, 19_090_909n)];
    const [p] = derivePositions(
      [ammMarket],
      held(52_032_086n, 0n),
      trades,
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 7_058_823n),
    );

    expect(p!.cost).toBe(50_000_000n);
  });

  /**
   * A provider is owed their slice of the pool's remaining winning side as
   * well as their own shares — counting only the shares would show them down
   * by the whole pool.
   */
  it("counts the pool claim towards a provider's entitlement", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(32_941_177n, 0n),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 7_058_823n),
    );

    // 32.941177 kept + 7.058823 still in the pool = the whole 40 minted.
    expect(p!.entitlement).toBe(40_000_000n);
    expect(p!.entitlement - p!.cost).toBe(0n);
  });

  /**
   * The total is right for a portfolio row and wrong for a button. `redeem()`
   * pays the shares and nothing else; the pool is a separate call behind a
   * separate guard. Shipped once as "Redeem 40 mUSDC" on a position that would
   * have paid 26.67.
   */
  it("separates what redeem() pays from what the pool still owes", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(26_666_667n, 0n),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 13_333_333n),
    );

    expect(p!.shareEntitlement).toBe(26_666_667n);
    expect(p!.shareClaimable).toBe(26_666_667n);
    // The whole-market totals are unchanged: 26.666667 + 13.333333 = 40.
    expect(p!.entitlement).toBe(40_000_000n);
    expect(p!.claimable).toBe(40_000_000n);
  });

  /**
   * A pool seeded at even money hands back no shares at all, so there is
   * nothing to redeem — but the pool claim alone kept `claimable` above zero
   * and put a Redeem button on screen that could only revert.
   */
  it("offers no redemption to a provider whose deposit left no shares", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(0n, 0n),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 40_000_000n),
    );

    expect(p!.shareClaimable).toBe(0n);
    expect(p!.claimable).toBe(40_000_000n);
  });

  /**
   * The invariant the portfolio's "claimable" filter leans on: `claimable`
   * stays above zero while EITHER half is outstanding. Filtering on the shares
   * flag as well hid a live pool claim from the one screen meant to find it.
   */
  it("still reports a pool claim once the shares have been redeemed", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(26_666_667n, 0n, true),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 13_333_333n),
    );

    expect(p!.claimed).toBe(true);
    expect(p!.claimable).toBe(13_333_333n);
  });

  /**
   * Same split as `claimable` vs `entitlement`: redeeming the shares must not
   * erase the record of what they were worth, or P&L reads flat on a win.
   */
  it("keeps the share entitlement after redeeming, while share claimable drops", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(26_666_667n, 0n, true),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 13_333_333n),
    );

    expect(p!.shareEntitlement).toBe(26_666_667n);
    expect(p!.shareClaimable).toBe(0n);
  });

  /**
   * Two providers split the pool by shares, not evenly. The claim comes from
   * the chain's own `lpPosition`, so this is really asserting that the value
   * is carried through rather than recomputed here.
   */
  it("gives each provider their pro-rata slice", () => {
    const lpEvents = [
      deposit(bob, 40_000_000n, 40_000_000n, 40_000_000n),
      deposit(alice, 20_000_000n, 20_000_000n, 60_000_000n, 1n),
    ];
    const [p] = derivePositions(
      [ammMarket],
      held(0n, 0n),
      [],
      alice,
      lpEvents,
      provided(20_000_000n, 60_000_000n, 3_000_000n),
    );

    expect(p!.cost).toBe(20_000_000n);
    expect(p!.entitlement).toBe(3_000_000n);
  });

  /**
   * A provider in a pool at even money holds NO residual shares — the reserves
   * take the whole deposit. Skipping positions on shares alone made their
   * entire stake vanish from the portfolio.
   */
  it("keeps a provider with no residual shares at all", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(0n, 0n),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 40_000_000n),
    );

    expect(p).toBeDefined();
    expect(p!.cost).toBe(40_000_000n);
    expect(p!.lp?.shares).toBe(40_000_000n);
  });

  /**
   * Redeeming shares and withdrawing from the pool are separate calls with
   * separate one-shot guards, so one being done must not hide the other.
   */
  it("still offers the pool claim after the shares have been redeemed", () => {
    const lpEvents = [deposit(alice, 40_000_000n, 40_000_000n, 40_000_000n)];
    const [p] = derivePositions(
      [ammMarket],
      held(32_941_177n, 0n, true),
      [],
      alice,
      lpEvents,
      provided(40_000_000n, 40_000_000n, 7_058_823n),
    );

    expect(p!.claimable).toBe(7_058_823n);
    expect(p!.status).not.toBe("Claimed");
  });

  /** Somebody who merely traded owes nothing for anyone else's deposit. */
  it("does not charge a plain trader for someone else's liquidity", () => {
    const lpEvents = [deposit(bob, 40_000_000n, 40_000_000n, 40_000_000n)];
    const trades = [trade("buy", 3_000_000n, 5_000_000n)];
    const [p] = derivePositions([ammMarket], held(5_000_000n, 0n), trades, alice, lpEvents);

    expect(p!.cost).toBe(3_000_000n);
    expect(p!.entitlement).toBe(5_000_000n);
    expect(p!.lp).toBeUndefined();
  });

  it("reports zero cost when the trade history could not be loaded", () => {
    // Events are allowed to fail independently of markets, so this must not
    // throw — it just cannot price the position.
    const [p] = derivePositions([ammMarket], held(5_000_000n, 0n), [], alice);
    expect(p!.cost).toBe(0n);
    expect(p!.entitlement).toBe(5_000_000n);
  });
});

describe("deriveTraders", () => {
  /**
   * Parimutuel is zero-sum by construction: the winners split exactly what the
   * losers put in. If the leaderboard does not sum to zero, it is
   * double-counting or losing a stake somewhere.
   */
  it("is zero-sum across a settled market", () => {
    const m = resolved(flight0, Outcome.Yes, 1_000_000n, 3_000_000n);
    const traders = deriveTraders(
      [m],
      [stake(m.key, alice, true, 1_000_000n), stake(m.key, bob, false, 3_000_000n)],
    );

    expect(traders.reduce((sum, t) => sum + t.profit, 0n)).toBe(0n);
    expect(traders.find((t) => t.address === alice)?.profit).toBe(3_000_000n);
    expect(traders.find((t) => t.address === bob)?.profit).toBe(-3_000_000n);
  });

  it("counts a void as neither a win nor a loss", () => {
    const m = resolved(crypto0, Outcome.Void, 1_000_000n, 1_000_000n);
    const [t] = deriveTraders([m], [stake(m.key, alice, true, 1_000_000n)]);

    expect(t!.settledMarkets).toBe(1);
    expect(t!.wins).toBe(0);
    expect(t!.profit).toBe(0n);
  });

  it("ignores markets that have not resolved", () => {
    const [t] = deriveTraders([flight0], [stake(flight0.key, alice, true, 1_000_000n)]);
    expect(t!.settledMarkets).toBe(0);
    expect(t!.profit).toBe(0n);
    // The stake still counts as capital committed, even unresolved.
    expect(t!.staked).toBe(1_000_000n);
  });

  /**
   * The same numeric id in two contracts, one won and one lost. Keyed by id
   * these would collapse together and report a single wrong figure.
   */
  it("does not merge same-id markets from different contracts", () => {
    const won = resolved(flight0, Outcome.Yes, 1_000_000n, 1_000_000n);
    const lost = resolved(crypto0, Outcome.No, 1_000_000n, 1_000_000n);

    const [t] = deriveTraders(
      [won, lost],
      [stake(won.key, alice, true, 1_000_000n), stake(lost.key, alice, true, 1_000_000n)],
    );

    expect(t!.settledMarkets).toBe(2);
    expect(t!.wins).toBe(1);
    // +1 on the won market, -1 on the lost one.
    expect(t!.profit).toBe(0n);
  });

  /**
   * AMM trades reach the leaderboard at all. They emit Bought/Sold rather than
   * Staked, and reading only Staked left every AMM trade invisible — a
   * leaderboard silently missing a whole category, which looks complete.
   */
  it("counts an AMM buy that wins", () => {
    const m = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;
    const buy: TradeEvent = {
      ...stake(m.key, alice, true, 3_000_000n),
      amm: { direction: "buy", shares: 5_307_692n, fee: 0n },
    };

    const [t] = deriveTraders([m], [buy]);
    // Paid 3, holds 5.307692 winning shares worth 1 each.
    expect(t!.profit).toBe(2_307_692n);
    expect(t!.wins).toBe(1);
  });

  it("counts an AMM buy that loses as the whole stake", () => {
    const m = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.No } as Market;
    const buy: TradeEvent = {
      ...stake(m.key, alice, true, 3_000_000n),
      amm: { direction: "buy", shares: 5_307_692n, fee: 0n },
    };
    expect(deriveTraders([m], [buy])[0]!.profit).toBe(-3_000_000n);
  });

  /**
   * Selling before expiry realises a result. Netting the sale off the money in
   * is what makes a closed position score what it actually made, rather than
   * nothing — and stops a buy-then-sell round trip reporting double the
   * capital ever risked.
   */
  it("nets an AMM sale off the money put in", () => {
    const m = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.No } as Market;
    const events: TradeEvent[] = [
      { ...stake(m.key, alice, true, 3_000_000n), amm: { direction: "buy", shares: 5_000_000n, fee: 0n } },
      {
        ...stake(m.key, alice, true, 4_000_000n),
        blockNumber: 2n,
        amm: { direction: "sell", shares: 5_000_000n, fee: 0n },
      },
    ];

    const [t] = deriveTraders([m], events);
    // Bought for 3, sold for 4, holds nothing: up 1 even though the side lost.
    expect(t!.profit).toBe(1_000_000n);
    // Capital at risk came back out, so nothing is still staked.
    expect(t!.staked).toBe(-1_000_000n + 0n + 0n);
  });

  it("leaves no position behind after a full round trip", () => {
    const m = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;
    const events: TradeEvent[] = [
      { ...stake(m.key, alice, true, 3_000_000n), amm: { direction: "buy", shares: 5_000_000n, fee: 0n } },
      {
        ...stake(m.key, alice, true, 2_900_000n),
        blockNumber: 2n,
        amm: { direction: "sell", shares: 5_000_000n, fee: 0n },
      },
    ];
    // Sold everything at a small loss; winning outcome pays nothing extra.
    expect(deriveTraders([m], events)[0]!.profit).toBe(-100_000n);
  });

  /** A partial sale leaves the rest of the position to settle normally. */
  it("handles selling only part of a position", () => {
    const m = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;
    const events: TradeEvent[] = [
      { ...stake(m.key, alice, true, 4_000_000n), amm: { direction: "buy", shares: 6_000_000n, fee: 0n } },
      {
        ...stake(m.key, alice, true, 1_500_000n),
        blockNumber: 2n,
        amm: { direction: "sell", shares: 2_000_000n, fee: 0n },
      },
    ];
    // In 4, back 1.5, 4m shares left paying 1 each.
    expect(deriveTraders([m], events)[0]!.profit).toBe(1_500_000n);
  });

  it("keeps AMM and parimutuel markets separate for one trader", () => {
    const ammM = { ...amm0, status: MarketStatus.Settled, outcome: Outcome.Yes } as Market;
    const pariM = resolved(flight0, Outcome.No, 1_000_000n, 1_000_000n);
    const events: TradeEvent[] = [
      { ...stake(ammM.key, alice, true, 1_000_000n), amm: { direction: "buy", shares: 2_000_000n, fee: 0n } },
      stake(pariM.key, alice, true, 1_000_000n),
    ];

    const [t] = deriveTraders([ammM, pariM], events);
    expect(t!.settledMarkets).toBe(2);
    // +1 on the AMM market, -1 on the parimutuel one.
    expect(t!.profit).toBe(0n);
  });

  it("sorts by profit, best first", () => {
    const m = resolved(flight0, Outcome.Yes, 1_000_000n, 3_000_000n);
    const traders = deriveTraders(
      [m],
      [stake(m.key, alice, true, 1_000_000n), stake(m.key, bob, false, 3_000_000n)],
    );
    expect(traders[0]!.address).toBe(alice);
  });
});

describe("deriveTraders — liquidity providers", () => {
  const settled = {
    ...amm0,
    status: MarketStatus.Settled,
    outcome: Outcome.Yes,
    yesReserve: 7_058_823n,
    totalLpShares: 40_000_000n,
  } as Market;

  const provide = (
    provider: `0x${string}`,
    amount: bigint,
    lpShares: bigint,
    totalLpShares: bigint,
  ): LpEvent => ({
    marketKey: settled.key,
    provider,
    direction: "add",
    amount,
    lpShares,
    totalLpShares,
    blockNumber: 1n,
    txHash: "0x00",
  });

  /**
   * A provider who never traded emits no Bought event, so a leaderboard built
   * from trades alone left them off entirely — however much they had at risk.
   * Underwriting the market is the position with the least visible risk here,
   * which makes omitting it flatter exactly the wrong people.
   */
  it("shows a provider who never traded", () => {
    const traders = deriveTraders(
      [settled],
      [],
      [provide(alice, 40_000_000n, 40_000_000n, 40_000_000n)],
    );

    expect(traders).toHaveLength(1);
    expect(traders[0]!.address).toBe(alice);
    expect(traders[0]!.staked).toBe(40_000_000n);
  });

  /** Their result is the pool claim against what they deposited. */
  it("scores the pool claim against the deposit", () => {
    const traders = deriveTraders(
      [settled],
      [],
      [provide(alice, 40_000_000n, 40_000_000n, 40_000_000n)],
    );

    // The pool kept 7.058823 of the winning side against a 40 deposit.
    expect(traders[0]!.profit).toBe(7_058_823n - 40_000_000n);
  });

  it("splits the claim between two providers by shares", () => {
    const traders = deriveTraders(
      [settled],
      [],
      [
        provide(alice, 20_000_000n, 20_000_000n, 20_000_000n),
        provide(bob, 20_000_000n, 20_000_000n, 40_000_000n),
      ],
    );

    const a = traders.find((t) => t.address === alice)!;
    const b = traders.find((t) => t.address === bob)!;
    expect(a.profit).toBe(b.profit);
  });

  /**
   * The deployer's ladder rung 1, as it stands on chain: 40 deposited, 22.86
   * handed back as Yes shares at the seed, and the 17.14 pool claim already
   * withdrawn — so the pool now reads zero. Valued from that empty pool, the
   * whole deposit scored as lost; the board showed -119 mUSDC for ladders that
   * had paid back exactly what went in.
   */
  it("counts residual shares, and a withdrawn claim at what it paid", () => {
    const drained = { ...settled, yesReserve: 0n, noReserve: 0n, totalLpShares: 0n } as Market;
    const traders = deriveTraders(
      [drained],
      [],
      [
        { ...provide(alice, 40_000_000n, 40_000_000n, 40_000_000n), marketKey: drained.key,
          yesResidual: 22_860_000n, noResidual: 0n },
        { marketKey: drained.key, provider: alice, direction: "withdraw", amount: 17_140_000n,
          lpShares: 40_000_000n, totalLpShares: 0n, blockNumber: 2n, txHash: "0x01" },
      ],
    );

    expect(traders[0]!.profit).toBe(0n);
  });

  /** Residual shares on the LOSING side pay nothing, and must not be scored. */
  it("values residual shares by the outcome, not at face", () => {
    const traders = deriveTraders(
      [settled],
      [],
      [{ ...provide(alice, 40_000_000n, 40_000_000n, 40_000_000n), yesResidual: 0n, noResidual: 5_000_000n }],
    );
    expect(traders[0]!.profit).toBe(7_058_823n - 40_000_000n);
  });
});
