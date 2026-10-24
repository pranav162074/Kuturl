# Stats query plans

How the stats endpoints were tuned, measured with `EXPLAIN (ANALYZE, BUFFERS)` on PostgreSQL 16.

## Setup

`scripts/explainStats.js` seeds a local database (it refuses to run against anything but localhost) with:

- 1,000,000 clicks over 180 days, in 7 monthly partitions
- 200,000 of them on one measured link, and 400 on each of 2,000 other links
- clicks inserted in time order, as the worker does, so one link's clicks are spread across the table rather than stored together
- hourly rollups built from those clicks (4,321 rows for the measured link)

It then runs `EXPLAIN (ANALYZE, BUFFERS)` on the exact SQL the API uses (`src/db/stats.js`). The numbers below are warm-cache runs. "Pages" is buffers touched (8 kB each), which matters more than milliseconds on a small shared database like Neon's free plan.

```
node scripts/explainStats.js          # seed, explain, clean up
node scripts/explainStats.js --keep   # keep the seeded data
node scripts/explainStats.js --reuse  # explain again without reseeding
```

## Results

| Query | Before | After |
|---|---|---|
| All-time total (`link_stats_hourly`) | 16.6 ms, 4,335 pages, bitmap heap scan | 0.6 ms, 25 pages, index-only scan |
| Daily series, 30 days | 0.9 ms, 703 pages, bitmap heap scan | 0.4 ms, 8 pages, index-only scan |
| Top referrers, 30 days | 14.8 ms, 1,725 pages, bitmap heap scan | 8.5 ms, 244 pages, index-only scan |
| Devices, 30 days | 11.3 ms, 1,719 pages, bitmap heap scan | 9.7 ms, 238 pages, index-only scan |
| Devices, 180 days | 52.6 ms, 10,278 pages, parallel bitmap heap scan | 29.9 ms, 1,422 pages, parallel index-only scan |
| Last click | 0.1 ms, 6 pages, index-only scan | unchanged |

Partition pruning already worked before any tuning: a 30-day query reads only the two monthly partitions that overlap the range.

## What changed (migration 0005)

**Clicks:** the index `(link_id, clicked_at)` became `(link_id, clicked_at) INCLUDE (referrer_host, device)`.
The old index found the right rows, but every row then had to be read from the table to get its referrer and device. Since clicks of one link are spread out, that was close to one page per click. With the two columns stored in the index, Postgres answers from the index alone (`Heap Fetches: 0`).

**Hourly rollups:** the primary key `(link_id, hour)` became `(link_id, hour) INCLUDE (clicks)`.
Same idea. The all-time total no longer reads one table page per hour of the link's life. It is still a single index, so writes do not maintain a second one.

## Costs

- **Storage.** Freshly built, the clicks index grows from 30 MB to 51 MB per million clicks (about 21 bytes per click). For a sense of scale, a million clicks is about 290 MB in total (135 MB table, 105 MB primary key, 51 MB covering index), which is why raw clicks are kept for only 6 months and the much smaller rollups are kept for good.
- **Writes.** Putting `clicks` in the rollup index means an update to the count must also update the index, so those updates can never be HOT (heap-only tuple) updates. Measured on 20,000 rollup upserts: 350 ms before, 355 ms after. Before the change only 104 of 18,072 updates were HOT anyway, because the table's pages are full. Lowering the fillfactor to win HOT updates back would make the index trade-off worth revisiting.
- **Index-only scans need the visibility map.** Pages written since the last vacuum still need table reads. Autovacuum handles insert-heavy tables like `clicks` (PostgreSQL 13+), and only the newest pages are affected.

## Known limits

- Days are UTC days. The rollups are hourly, so a timezone with a half-hour offset (India, UTC+5:30) cannot be bucketed exactly from them. Supporting that would need 30-minute rollups.
- Stats trail the clicks by however far behind the worker is, which is normally a few seconds.
- Totals include bots. The rollups have no device dimension; the devices endpoint shows how many clicks were bots.
