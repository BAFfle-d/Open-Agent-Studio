# Market research — status: NOT PERFORMED (no live data pulled)

I did not pull live market data this session, so there are **no regime call, no finalists and no
metrics here**. Listing tokens with TVL/unlock figures from memory would be fabrication, and
anything dated after my training cutoff is stale by construction. Run this protocol with live feeds
and have the numbers carry a retrieval date.

## Regime inputs (primary sources)
- BTC/ETH trend, funding, OI, basis: venue public APIs (e.g. Binance/Bybit/OKX/Deribit REST).
- Stablecoin supply/liquidity: DefiLlama stablecoins API; issuer attestations (Circle, Tether).
- Dominance: CoinGecko/CMC APIs. Macro: FRED (rates, DXY proxy), FOMC calendar (federalreserve.gov).

## Per-candidate dossier (one file each: `docs/finalists/<TICKER>.md`)
Supply & unlock schedule (project docs + on-chain vesting contracts) · revenue/fees (DefiLlama,
Token Terminal) · TVL, active users · holder concentration (Etherscan/Dune) · **value accrual
(does fee revenue reach token holders by mechanism, not narrative?)**.
Required sections: Confirmed catalysts (with source+date) | Speculative catalysts (labeled) |
Bear case (written first) | Invalidation conditions (numeric, pre-registered) | Priced-in check
(funding, OI, perp basis, price move since catalyst announced) | Estimated costs/slippage at target size.

## Finalist -> Jev
A finalist only becomes a `thesis_id` for `jev_schema.to_spec()`. Thesis facts shape *which*
instruments run; they are not fed to Jev per candle. Reject any candidate where the only edge
is incentive-driven (airdrop/points farming flows) or unlock-adjusted float < size you'd trade.
