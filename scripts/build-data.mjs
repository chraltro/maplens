/**
 * Turn the UN WPP 2024 bulk CSVs into a compact snapshot file for the web app.
 *
 * The three source files are ~257 MB gzipped and cover 1950-2100 at single-year
 * resolution for 237 countries plus aggregates. The app needs 17 age brackets
 * for a handful of decades, so this reduces roughly 1000:1 and ships JSON.
 *
 * Downloads are cached in raw/ (gitignored). Re-running is cheap.
 *
 *   node scripts/build-data.mjs
 *
 * Data: UN DESA Population Division, World Population Prospects 2024.
 * Licensed CC BY 3.0 IGO.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'raw');
const OUT = join(ROOT, 'public', 'data');

const BASE = 'https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES/';

const FILES = {
  population: 'WPP2024_PopulationByAge5GroupSex_Medium.csv.gz',
  fertility: 'WPP2024_Fertility_by_Age5.csv.gz',
  lifeTable: 'WPP2024_Life_Table_Abridged_Medium_1950-2023.csv.gz',
};

/** Decade snapshots. The WPP estimates series ends at 2023. */
const YEARS = [1953, 1963, 1973, 1983, 1993, 2003, 2013, 2023];
const YEAR_SET = new Set(YEARS);

const AGE_BRACKETS = [
  '0-4', '5-9', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39',
  '40-44', '45-49', '50-54', '55-59', '60-64', '65-69', '70-74', '75-79', '80+',
];
const AGE_INDEX = new Map(AGE_BRACKETS.map((a, i) => [a, i]));

/**
 * Map a WPP age group label onto our bracket index.
 *
 * Handles two source quirks:
 * - The abridged life table has no "0-4" row: it splits infancy into "0"
 *   (span 1) and "1-4" (span 4), because infant mortality is far too different
 *   from ages 1-4 to average. Both fold into bracket 0.
 * - Ages above 80 are split into 80-84 ... 100+; all fold into the last bracket.
 */
function ageIdx(grp) {
  const direct = AGE_INDEX.get(grp);
  if (direct !== undefined) return direct;
  const start = parseInt(grp, 10);
  if (!Number.isFinite(start)) return undefined;
  if (start >= 80) return AGE_BRACKETS.length - 1;
  if (start < 5) return 0; // "0" and "1-4"
  return Math.min(Math.floor(start / 5), AGE_BRACKETS.length - 1);
}

const FERT_FIRST = 3; // 15-19
const FERT_LAST = 9;  // 45-49
const N_FERT = FERT_LAST - FERT_FIRST + 1;

/**
 * Minimal RFC4180-ish parser. The Location column contains quoted commas
 * ("Australia and New Zealand"), so splitting on ',' corrupts alignment.
 */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      out.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

async function download(name) {
  const dest = join(RAW, name);
  try {
    const s = await stat(dest);
    if (s.size > 0) {
      console.log(`  cached  ${name} (${(s.size / 1e6).toFixed(1)} MB)`);
      return dest;
    }
  } catch { /* not cached */ }

  const url = BASE + name;
  console.log(`  fetch   ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const s = await stat(dest);
  console.log(`          ${(s.size / 1e6).toFixed(1)} MB`);
  return dest;
}

/**
 * Stream a gzipped CSV, invoking `onRow(cols, idx)` per data row.
 * `idx` maps column name -> position, read from the header.
 */
async function readCsv(path, onRow) {
  const rl = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let idx = null;
  for await (const line of rl) {
    if (!line) continue;
    if (idx === null) {
      // Strip UTF-8 BOM before reading header names.
      const header = parseCsvLine(line.replace(/^﻿/, ''));
      idx = new Map(header.map((h, i) => [h.trim(), i]));
      continue;
    }
    onRow(parseCsvLine(line), idx);
  }
}

const countries = new Map();

function blankSnapshot() {
  return {
    male: new Array(AGE_BRACKETS.length).fill(0),
    female: new Array(AGE_BRACKETS.length).fill(0),
    mortMale: new Array(AGE_BRACKETS.length).fill(0),
    mortFemale: new Array(AGE_BRACKETS.length).fill(0),
    fertShare: new Array(N_FERT).fill(0),
    tfr: 0, e0: 0, total: 0, medianAge: 0,
  };
}

function slot(iso3, name, year) {
  let c = countries.get(iso3);
  if (!c) {
    c = { iso3, name, centroid: [0, 0], years: {} };
    countries.set(iso3, c);
  }
  if (!c.years[year]) c.years[year] = blankSnapshot();
  return c.years[year];
}

/** Country rows only: aggregates have an empty ISO3 and a different LocType. */
function countryRow(cols, idx) {
  const iso3 = cols[idx.get('ISO3_code')]?.trim();
  if (!iso3 || iso3.length !== 3) return null;
  if (cols[idx.get('LocTypeName')]?.trim() !== 'Country/Area') return null;
  const year = Number(cols[idx.get('Time')]);
  if (!YEAR_SET.has(year)) return null;
  return { iso3, name: cols[idx.get('Location')]?.trim() ?? iso3, year };
}

async function ingestPopulation(path) {
  console.log('  parse   population by age & sex');
  let rows = 0;
  await readCsv(path, (cols, idx) => {
    const r = countryRow(cols, idx);
    if (!r) return;
    const i = ageIdx(cols[idx.get('AgeGrp')]?.trim());
    if (i === undefined) return;
    const s = slot(r.iso3, r.name, r.year);
    s.male[i] += Number(cols[idx.get('PopMale')]) || 0;
    s.female[i] += Number(cols[idx.get('PopFemale')]) || 0;
    rows++;
  });
  console.log(`          ${rows.toLocaleString()} rows kept`);
}

async function ingestFertility(path) {
  console.log('  parse   fertility by age of mother');
  let rows = 0;
  const tfrAcc = new Map();

  await readCsv(path, (cols, idx) => {
    // This file carries ~15 projection variants; without this filter the row
    // count multiplies and projections contaminate the historical series.
    if (cols[idx.get('Variant')]?.trim() !== 'Medium') return;
    const r = countryRow(cols, idx);
    if (!r) return;

    const i = ageIdx(cols[idx.get('AgeGrp')]?.trim());
    if (i === undefined) return;

    // TFR sums every reproductive bracket the source reports, including the
    // 10-14 and 50-54 tails that fall outside the arm's 15-49 display window.
    // ASFR is births per 1000 women per year, over a 5-year bracket.
    const key = `${r.iso3} ${r.year}`;
    const asfr = (Number(cols[idx.get('ASFR')]) || 0) * 5 / 1000;
    tfrAcc.set(key, (tfrAcc.get(key) ?? 0) + asfr);

    if (i < FERT_FIRST || i > FERT_LAST) return;
    const s = slot(r.iso3, r.name, r.year);
    s.fertShare[i - FERT_FIRST] += Number(cols[idx.get('Births')]) || 0;
    rows++;
  });

  for (const [key, tfr] of tfrAcc) {
    const [iso3, year] = key.split(' ');
    const s = countries.get(iso3)?.years[year];
    if (s) s.tfr = tfr;
  }
  console.log(`          ${rows.toLocaleString()} rows kept`);
}

async function ingestLifeTable(path) {
  console.log('  parse   abridged life tables');
  let rows = 0;

  /**
   * Several source rows fold into one bracket (0 + 1-4; 80-84 ... 100+).
   * Death rates cannot be combined by max or by a plain mean: the correct
   * bracket rate is total deaths over total exposure. The life table gives us
   * both directly, as dx (deaths) and Lx (person-years lived), so accumulate
   * those and divide at the end.
   */
  const acc = new Map(); // "iso:year:sex:bracket" -> { dx, Lx }

  await readCsv(path, (cols, idx) => {
    const r = countryRow(cols, idx);
    if (!r) return;
    const sex = cols[idx.get('Sex')]?.trim();
    const grp = cols[idx.get('AgeGrp')]?.trim();
    const s = slot(r.iso3, r.name, r.year);

    // Life expectancy at birth is the ex value on the age-0 row.
    if (sex === 'Total' && grp === '0') {
      s.e0 = Number(cols[idx.get('ex')]) || 0;
    }

    const i = ageIdx(grp);
    if (i === undefined) return;
    if (sex !== 'Male' && sex !== 'Female') return;

    const key = `${r.iso3} ${r.year} ${sex} ${i}`;
    let a = acc.get(key);
    if (!a) { a = { dx: 0, Lx: 0 }; acc.set(key, a); }
    a.dx += Number(cols[idx.get('dx')]) || 0;
    a.Lx += Number(cols[idx.get('Lx')]) || 0;
    rows++;
  });

  for (const [key, { dx, Lx }] of acc) {
    const [iso3, year, sex, i] = key.split(' ');
    const s = countries.get(iso3)?.years[year];
    if (!s || Lx <= 0) continue;
    // Deaths per 1000 person-years lived in the bracket.
    const rate = (dx / Lx) * 1000;
    if (sex === 'Male') s.mortMale[Number(i)] = rate;
    else s.mortFemale[Number(i)] = rate;
  }

  console.log(`          ${rows.toLocaleString()} rows kept`);
}

/** Median age from the 5-year histogram, interpolating within the bracket. */
function medianAge(male, female) {
  const total = male.reduce((a, b) => a + b, 0) + female.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let cum = 0;
  for (let i = 0; i < male.length; i++) {
    const n = male[i] + female[i];
    if (cum + n >= total / 2) {
      const within = (total / 2 - cum) / (n || 1);
      return i * 5 + within * 5;
    }
    cum += n;
  }
  return 0;
}

function finalise() {
  const out = { years: YEARS, countries: {} };
  let dropped = 0;

  for (const [iso3, c] of countries) {
    const years = {};
    for (const y of YEARS) {
      const s = c.years[y];
      if (!s) continue;
      const total = s.male.reduce((a, b) => a + b, 0) + s.female.reduce((a, b) => a + b, 0);
      if (total <= 0) continue;

      // Births -> share of total childbearing.
      const bTotal = s.fertShare.reduce((a, b) => a + b, 0);
      const fertShare = bTotal > 0 ? s.fertShare.map((b) => b / bTotal) : new Array(N_FERT).fill(0);

      const r2 = (v) => Math.round(v * 100) / 100;
      const r4 = (v) => Math.round(v * 10000) / 10000;
      years[y] = {
        male: s.male.map(r2),
        female: s.female.map(r2),
        mortMale: s.mortMale.map(r2),
        mortFemale: s.mortFemale.map(r2),
        fertShare: fertShare.map(r4),
        tfr: r2(s.tfr),
        e0: r2(s.e0),
        total: r2(total),
        medianAge: r2(medianAge(s.male, s.female)),
      };
    }
    if (Object.keys(years).length === 0) { dropped++; continue; }
    out.countries[iso3] = { iso3, name: c.name, centroid: [0, 0], years };
  }

  const n = Object.keys(out.countries).length;
  console.log(`  build   ${n} countries, ${YEARS.length} snapshots${dropped ? ` (${dropped} dropped, no data)` : ''}`);
  return out;
}

async function main() {
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });

  console.log('WPP 2024 -> demography.json\n');
  console.log('Downloading (cached in raw/, ~257 MB first run):');
  const pop = await download(FILES.population);
  const fert = await download(FILES.fertility);
  const lt = await download(FILES.lifeTable);

  console.log('\nParsing:');
  await ingestPopulation(pop);
  await ingestFertility(fert);
  await ingestLifeTable(lt);

  console.log('');
  const dataset = finalise();
  const dest = join(OUT, 'demography.json');
  await writeFile(dest, JSON.stringify(dataset));
  const s = await stat(dest);
  console.log(`\n  wrote   public/data/demography.json (${(s.size / 1e6).toFixed(2)} MB)`);
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
