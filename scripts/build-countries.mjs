/**
 * Build public/data/countries.geojson: country polygons the map can hit-test.
 *
 * Source: Natural Earth 1:50m admin-0 (public domain), which is detailed
 * enough for small states but ~5x lighter than the 10m set.
 *
 * Two things this fixes rather than passing through:
 *
 * 1. Natural Earth's ISO_A3 is "-99" for Norway, France, Kosovo and others.
 *    Those countries would silently never match a WPP row. ISO_A3_EH carries
 *    the de-facto codes and fixes Norway/France; the rest fall back to
 *    ADM0_A3, which is always populated.
 * 2. Every feature gets a numeric id, because MapLibre's setFeatureState
 *    needs one and GeoJSON string ids are not accepted for it.
 *
 * Properties are stripped to ISO_A3 + NAME: the file is fetched by the
 * browser, and the source carries 70+ fields per feature, mostly translations.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data');

const SRC = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';

/** Antarctica has no WPP population and eats a third of the map. */
const SKIP = new Set(['ATA']);

function isoOf(p) {
  for (const key of ['ISO_A3_EH', 'ISO_A3', 'ADM0_A3']) {
    const v = p[key];
    if (v && v !== '-99' && String(v).length === 3) return v;
  }
  return null;
}

/** Area-weighted centroid of the largest ring, good enough to fly to. */
function centroid(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null;
  let bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      const f = x0 * y1 - x1 * y0;
      a += f;
      cx += (x0 + x1) * f;
      cy += (y0 + y1) * f;
    }
    a *= 0.5;
    if (Math.abs(a) > bestArea) {
      bestArea = Math.abs(a);
      best = a === 0 ? ring[0] : [cx / (6 * a), cy / (6 * a)];
    }
  }
  return best ? [Number(best[0].toFixed(3)), Number(best[1].toFixed(3))] : [0, 0];
}

/** Drop vertices below the map's smallest visible detail. */
function roundGeom(geom, dp = 3) {
  const r = (n) => Number(n.toFixed(dp));
  const walk = (c) => (typeof c[0] === 'number' ? [r(c[0]), r(c[1])] : c.map(walk));
  return { type: geom.type, coordinates: walk(geom.coordinates) };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  console.log('Natural Earth 50m -> countries.geojson\n');
  console.log('  fetch   ne_50m_admin_0_countries.geojson');
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const src = await res.json();
  console.log(`          ${src.features.length} features`);

  const features = [];
  const centroids = {};
  const skipped = [];
  let id = 1;

  for (const f of src.features) {
    const iso = isoOf(f.properties);
    const name = f.properties.NAME_EN || f.properties.NAME || iso;
    if (!iso) { skipped.push(name); continue; }
    if (SKIP.has(iso)) continue;

    features.push({
      type: 'Feature',
      id: id++,
      properties: { ISO_A3: iso, NAME: name },
      geometry: roundGeom(f.geometry),
    });
    centroids[iso] = centroid(f.geometry);
  }

  const out = { type: 'FeatureCollection', features };
  const dest = join(OUT, 'countries.geojson');
  await writeFile(dest, JSON.stringify(out));
  await writeFile(join(OUT, 'centroids.json'), JSON.stringify(centroids));

  const kb = (JSON.stringify(out).length / 1e6).toFixed(2);
  console.log(`  build   ${features.length} countries kept`);
  if (skipped.length) console.log(`          skipped (no ISO code): ${skipped.join(', ')}`);
  console.log(`\n  wrote   public/data/countries.geojson (${kb} MB)`);
  console.log(`  wrote   public/data/centroids.json`);
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
