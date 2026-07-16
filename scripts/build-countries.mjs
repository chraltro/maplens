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

/**
 * Ramer-Douglas-Peucker: drop vertices that sit within `tol` degrees of the
 * line between their neighbours.
 *
 * This layer exists to answer "which country is under this one point", and it
 * is hit-tested on every frame of a pan. Full Natural Earth coastline is ~95k
 * vertices, which is what makes that hit-test slow enough to feel; fjords and
 * inlets contribute nothing to the answer.
 */
function simplifyRing(ring, tol) {
  if (ring.length <= 4) return ring;

  const sqTol = tol * tol;
  const sqSegDist = (p, a, b) => {
    let [x, y] = a;
    let dx = b[0] - x;
    let dy = b[1] - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) [x, y] = b;
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x;
    dy = p[1] - y;
    return dx * dx + dy * dy;
  };

  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = 0;
    let idx = 0;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(ring[i], ring[first], ring[last]);
      if (sq > maxSq) { idx = i; maxSq = sq; }
    }
    if (maxSq > sqTol) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }

  const out = ring.filter((_, i) => keep[i]);
  // A ring needs 4 points (first == last) to stay a valid polygon.
  return out.length >= 4 ? out : ring.slice(0, 4);
}

/** Extent of a ring in degrees: the smaller side of its bounding box. */
function ringExtent(ring) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Math.min(x1 - x0, y1 - y0);
}

/**
 * Simplify a geometry for hit-testing, with tolerance scaled to each ring's
 * own size.
 *
 * A single global tolerance cannot work: one loose enough to be worth applying
 * to Russia's coastline is several times wider than Vatican City (0.007
 * degrees across), and would erase microstates entirely. Rings at or below the
 * tolerance are kept whole. They are cheap, and they are precisely the ones
 * that cannot afford to lose vertices.
 */
function reduceGeom(geom, dp = 3) {
  const r = (n) => Number(n.toFixed(dp));
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const out = [];

  for (const poly of polys) {
    const rings = [];
    for (const ring of poly) {
      const extent = ringExtent(ring);
      // Never displace a vertex by more than ~1.5% of its ring's short side.
      const tol = Math.min(0.12, extent * 0.015);
      const simple = (extent < 0.06 ? ring : simplifyRing(ring, tol))
        .map(([x, y]) => [r(x), r(y)]);
      if (simple.length >= 4) rings.push(simple);
    }
    if (rings.length) out.push(rings);
  }

  if (!out.length) return null;
  return out.length === 1
    ? { type: 'Polygon', coordinates: out[0] }
    : { type: 'MultiPolygon', coordinates: out };
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

  let before = 0;
  let after = 0;
  const countVerts = (geom) => {
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    let n = 0;
    for (const p of polys) for (const r of p) n += r.length;
    return n;
  };

  for (const f of src.features) {
    const iso = isoOf(f.properties);
    const name = f.properties.NAME_EN || f.properties.NAME || iso;
    if (!iso) { skipped.push(name); continue; }
    if (SKIP.has(iso)) continue;

    const geometry = reduceGeom(f.geometry);
    if (!geometry) { skipped.push(`${name} (no geometry left)`); continue; }

    before += countVerts(f.geometry);
    after += countVerts(geometry);

    features.push({
      type: 'Feature',
      id: id++,
      properties: { ISO_A3: iso, NAME: name },
      geometry,
    });
    // Centroid from the ORIGINAL outline: simplification is for hit-testing,
    // and a flyTo target should not inherit its error.
    centroids[iso] = centroid(f.geometry);
  }

  const out = { type: 'FeatureCollection', features };
  const dest = join(OUT, 'countries.geojson');
  await writeFile(dest, JSON.stringify(out));
  await writeFile(join(OUT, 'centroids.json'), JSON.stringify(centroids));

  const kb = (JSON.stringify(out).length / 1e6).toFixed(2);
  console.log(`  build   ${features.length} countries kept`);
  console.log(`          ${before.toLocaleString()} -> ${after.toLocaleString()} vertices ` +
              `(${(100 - (after / before) * 100).toFixed(1)}% dropped)`);
  if (skipped.length) console.log(`          skipped: ${skipped.join(', ')}`);
  console.log(`\n  wrote   public/data/countries.geojson (${kb} MB)`);
  console.log(`  wrote   public/data/centroids.json`);
}

main().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
