# Intermarket Rates Dashboard

Run `start-dashboard.cmd` to open the dashboard at [127.0.0.1:8765](http://127.0.0.1:8765/). Keep the launcher window running while you use it. The launcher uses this folder’s virtual environment if present, then checks the existing inter-market environment and installed Python.

The dashboard starts in **Export snapshot** mode using the supplied last-trade and settlement prices. Click **Connect live**, enter your Hertshten work email, and complete Microsoft device sign-in if prompted. The board switches to **Live VWAP** when the first L1 VWAP arrives. Live access uses the same Microsoft app and L1 subscription settings as the supplied examples. The server runs on loopback and keeps the dashboard’s tokens in process memory.

If live dependencies are missing, open PowerShell in this folder and run the following with a Python 3.10+ installation. Use `python` in place of `py -3` if needed.

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\start-dashboard.cmd
```

## Screens

| Screen | What you can do |
| --- | --- |
| VWAP Board | View SR3, Euribor, and SONIA outrights and 3M, 6M, 12M, or 24M spreads and flies side by side. Select **All deliveries** for serial months or **Earlier contracts** for older starts. |
| Live Prices | View the live price in basis points above the selected percentile for quarterly spreads, flies, and saved strategies. Choose a 30-, 60-, 90-, or 240-calendar-day lookback. **Level** and **Change** from the supplied settlement are also available. |
| Curves | Click a market in the legend to focus it and use **From** and **Through** to zoom by start delivery. **Focused range** uses edge markers for outlying points, with their exact values in the table or on hover. **Full range** fits all values. |
| Strategies | Start with **6M fly − 2 × 3M fly** or another preset. Add weighted legs by market and product. **Same market (each)** values a strategy independently for SR3, Euribor, and SONIA. Offsets move a leg by whole calendar quarters from each row’s starting delivery. Save a strategy to reuse it in the simulator. |
| Simulator | Override quarterly 3M or 6M spreads independently by market in Scenario A or B. Select any supported curve or a saved strategy. Overlay the market baseline or the other scenario to see a value-by-value difference. |

Saved strategies and scenario inputs persist in the browser profile used to open the dashboard, at the launch address above.

Use **Dark mode** in the dashboard header to switch themes. The dashboard saves the selection in the browser profile.

On any chart, scroll over the plot to zoom around the pointer. Double-click to reset the zoom. With the chart focused, use **+**, **−**, or **0** for the same controls.

## Pricing conventions

- Outrights are futures price points. Spreads and flies are basis points. SR3 package quotes are already in basis points. Euribor and SONIA package quotes are multiplied by 100 for display. These conventions were checked against live outright and spread VWAPs.
- A spread is front price minus back price. A fly is front minus twice the middle plus the back, with equally spaced legs. A 24M fly has a 24-month gap between adjacent legs.
- An **L1 VWAP** badge identifies the feed’s VWAP for the listed instrument. An **Implied** badge identifies a package calculated from the selected source’s outright prices. Turn off **Include implied** to see only direct package prices on the board and curves.
- Live Prices compares listed VWAPs to listed export settlements and implied prices to implied settlements. A strategy change compares the same legs and weights on both sides. The export is a fixed reference, so the colour can represent a change over more than one trading session.
- Percentiles rank the displayed live package VWAP against traded QuantHub daily closes in the selected calendar-day window. Today's session is excluded. A percentile needs at least five observations and values tied with the live level count at half weight. When using implied history, the dashboard uses only dates with traded closes for every constituent outright.
- The live strategy preview and saved strategies use dates common to every leg and apply the same weights and delivery offsets. Listed live legs use listed closes. Implied live legs use closes from the corresponding outright legs. Hover over a rank for the window, counts below and tied, and historical range.
- A corner marker flags a listed Live Prices VWAP whose magnitude is at least 250 bp and more than ten times every available like-for-like reference. The board uses the implied value if available.
- Live outright values whose scale differs from their exported price by a factor of ten or more are flagged and excluded from calculations.
- The simulator uses outright-implied spreads for blank inputs. In 3M mode it chains quarterly spreads from the front outright anchor. A 6M strip has two alternating chains. The front 3M bridge joins them using the selected baseline or the input you enter. Where legs are connected, spreads and flies can be calculated without an absolute anchor. Unavailable values stay blank.
- **Market baseline** in a comparison uses the selected source’s listed prices where available, with implied values as a fallback. It can differ from an unedited scenario because the scenario is calculated from outrights. A strategy’s outright leg is converted to basis points before its weight is applied.

## Refresh the instrument catalogue

The current catalogue contains 614 IDs from the six SR3, Euribor, and SONIA exports and 58 historical IDs verified through the NextGen RTD instrument lookup. Refresh it with updated instrument export files, keeping the original filenames. The importer also reads `nextgen-instrument-ids.json` and keeps export prices when a contract and its NextGen ID agree.

```powershell
py -3 import_catalog.py 'C:\path\to\instrument-exports'
```

Restart the dashboard after refreshing the catalogue. The importer uses contract names, IDs, and last/settlement prices from the exports.

Windows Task Scheduler runs **Intermarket Dashboard - QuantHub History** at 07:00 London time each day under the signed-in user's profile. It catches up after a missed start and retries failed runs hourly. It needs the existing QuantHub configuration and access to the company network. View recent runs in `history-refresh.log`.

Live Prices shows the last successful QuantHub refresh in London time and checks for updated history every two minutes while visible. A failed attempt shows a stale-history warning and preserves the last successful timestamp and closes. The warning clears after the next success. To run an on-demand refresh, start the scheduled task or run `python refresh_history.py`.
