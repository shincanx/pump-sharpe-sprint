# pump-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/shincanx/pump-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/shincanx/pump-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for pump.fun's 6-hour replay. Entry 2 ("TrailHunter"): it buys young coins (age ≤ 2400 slots, still under 1.3x their create price) only on **sustained** momentum — at least +10% over the last 10 trades with at least 87.5% of the last 8 trades being buys — then rides winners with a trailing stop (arms at +30%, trails 10%), pyramids up +12% at a time, cuts losers at −7%, and holds up to 600 slots so real runners can complete. Guardrail probes keep the entry compliant (≥20 distinct mints) on quiet windows.

Grade-local (dev 24h, `--driver process`): net PnL **+0.244 SOL**, max drawdown **0.68%**, 223 fills over 42 coins, 107 round trips, still **+0.167 SOL at 2x fees**.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot . --driver docker
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwvw22pf&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
