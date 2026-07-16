# maplens

A world map you drag around. A lens fixed at the centre of the viewport reads
whatever country sits under the crosshair and draws its profile, live, as you
pan.

The lens is the point. Demographics are just the first thing plugged into it:
the current view shows population, mortality and fertility as three pyramids
around a dial, from UN World Population Prospects 2024. Any country-keyed
dataset could drive it instead.

Inspired by [VisQuill's Demographic Profiles](https://visquill.com/gallery/world-demographics/)
by Dr. Benjamin Niedermann. This is an independent implementation, not a fork:
the VisQuill GDK is not used here (it is free for non-commercial use with
attribution, and is not published on npm). The map, the lens geometry and the
reactive layer are built from scratch on MapLibre GL JS.

## Running it

```
npm install
npm run countries   # build country polygons  (~10s, 1.6 MB out)
npm run data        # build demographic data  (~5 min first run, 257 MB download)
npm run dev
```

`npm run data` caches the source CSVs in `raw/` (gitignored), so re-running it
is fast. Both data steps must run before `npm run dev`, or the app will show a
load error telling you which one is missing.

## How it fits together

```
src/map/map.ts                MapLibre, and the country-under-crosshair lookup
src/lens/reactive.ts          Signals, springs, and an idle-when-settled ticker
src/lens/geometry.ts          Pure geometry: pyramids bent around a dial
src/lens/lens.ts              The lens: SVG, animation, readout
src/main.ts                   Wiring: data -> map focus -> lens

src/data/types.ts             The demographic dataset's shape
scripts/build-countries.mjs   Natural Earth 50m  -> public/data/countries.geojson
scripts/build-data.mjs        UN WPP 2024 CSVs   -> public/data/demography.json
```

The first three are dataset-agnostic. `map.ts` only ever emits an ISO3 code;
`reactive.ts` and `geometry.ts` know nothing about demography at all. What ties
the lens to this particular data is `lens.ts` (which reads `Snapshot` fields
and decides how to normalise them) plus the two build scripts.

Swapping in another country-keyed dataset means a new build script, a new
`Snapshot` type, and reworking the arms in `lens.ts`. Everything else stands.
Note that the three-pyramid arrangement is itself a demographic choice: a
dataset without an age dimension would want a different mark entirely, and the
geometry does not currently offer one.

The interaction lives in two places. `map.ts` samples the country under the
viewport centre on every `move` event (not `moveend`, which is what makes the
lens track a drag continuously rather than snapping when it ends). `lens.ts`
animates toward each new snapshot with critically damped springs, which
retarget mid-flight without a visible restart, so a fast pan across several
countries stays smooth instead of stuttering between them.

## Data notes

Source: [UN World Population Prospects 2024](https://population.un.org/wpp/),
UN DESA Population Division, licensed CC BY 3.0 IGO. The pipeline reduces
roughly 257 MB of gzipped CSV to a 1.1 MB JSON: 237 countries, 17 age bands,
at decade snapshots from 1953 to 2023.

Five things about these files that are not obvious, each of which silently
produces wrong output rather than an error:

- **The download URLs are not discoverable from the site.** The WPP download
  page is an Angular app that fetches its file manifest at runtime from
  `https://population.un.org/wpp/assets/downloads.json`. The paths in that
  manifest are the only reliable source; older `Download/Files/...` URLs 404.
- **The population and fertility files span 1950-2100, not 1950-2023.** Only
  the life table carries a year range in its filename. Filter on `Time`, or
  projections silently enter the historical series.
- **The fertility file contains every projection variant.** Medium, High, Low,
  Momentum, Zero migration, and others, all interleaved. Filter
  `Variant == "Medium"` or the row count multiplies about fifteenfold.
- **The abridged life table has no `0-4` row.** It splits infancy into `0`
  (span 1) and `1-4` (span 4), because infant mortality is far too different
  from ages 1-4 to average. Match only `0-4` and child mortality silently
  becomes zero for every country in the world.
- **`Location` values contain commas** (`"Australia and New Zealand"`, quoted).
  Splitting on `,` corrupts column alignment. `build-data.mjs` uses a real CSV
  parser and keys off `ISO3_code`.

Two more, on the geography side:

- **Natural Earth's `ISO_A3` is `-99` for Norway and France**, among others.
  Joining on it drops those countries entirely. `build-countries.mjs` prefers
  `ISO_A3_EH`, falling back to `ADM0_A3`.
- **Mortality rates cannot be combined across bands by max or plain mean.**
  Where several source rows fold into one band (`0` + `1-4`; `80-84` through
  `100+`), the correct rate is total deaths over total exposure. The pipeline
  accumulates the life table's `dx` and `Lx` and divides at the end.

## Reading the lens

Each arm is a population pyramid mirrored about a spine, age running outward
from the core, male one side and female the other. Age pills ride the spine.

- **Population** is scaled to each country's own largest band, so the shape is
  comparable between countries of very different sizes. Absolute numbers are
  in the readout.
- **Mortality** is deaths per 1,000 person-years, on a log scale against a
  fixed ceiling (the worst band in the whole 1950-2023 series is ~353). Fixed
  rather than per-country, so the arm stays comparable as you pan. Log rather
  than linear because age-specific death rates span orders of magnitude, and
  linearly everything below age 60 is an invisible stub.
- **Fertility** is the share of a country's births occurring in each five-year
  band from 15-49, so it shows the shape of childbearing rather than its
  volume. The headline TFR in the readout counts every band the source
  reports, including the 10-14 and 50-54 tails outside the displayed window.

## Licences

Code in this repository is yours to license as you see fit. The data and tiles
carry their own terms:

- UN World Population Prospects 2024: CC BY 3.0 IGO
- Natural Earth: public domain
- Map tiles: [OpenFreeMap](https://openfreemap.org/), OpenStreetMap data, ODbL
