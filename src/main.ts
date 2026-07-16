import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

import type { Dataset } from './data/types';
import { Lens } from './lens/lens';
import { MapLayer } from './map/map';

const DATA_URL = '/data/demography.json';
const COUNTRIES_URL = '/data/countries.geojson';
const CENTROIDS_URL = '/data/centroids.json';

async function boot(): Promise<void> {
  const [dataset, centroids] = await Promise.all([
    fetch(DATA_URL).then((r) => {
      if (!r.ok) throw new Error(`demography.json: ${r.status} — run \`npm run data\``);
      return r.json() as Promise<Dataset>;
    }),
    fetch(CENTROIDS_URL).then((r) => {
      if (!r.ok) throw new Error(`centroids.json: ${r.status} — run \`npm run countries\``);
      return r.json() as Promise<Record<string, [number, number]>>;
    }),
  ]);

  const lens = new Lens();
  document.getElementById('lens-mount')!.appendChild(lens.root);

  const map = new MapLayer({
    container: document.getElementById('map')!,
    countriesUrl: COUNTRIES_URL,
  });

  // Year is a plain index into dataset.years so the slider stays evenly spaced
  // even though the snapshots are a decade apart.
  const slider = document.getElementById('year') as HTMLInputElement;
  const yearOut = document.getElementById('year-out') as HTMLOutputElement;
  slider.max = String(dataset.years.length - 1);
  const initial = Math.max(0, dataset.years.length - 1);
  slider.value = String(initial);

  let yearIndex = initial;
  yearOut.textContent = String(dataset.years[yearIndex]);

  const paint = (): void => {
    const iso = map.focus.get();
    const year = dataset.years[yearIndex]!;
    const country = iso ? dataset.countries[iso] : undefined;
    const snap = country?.years[year] ?? null;
    lens.show(snap, country?.name ?? '');
  };

  map.focus.subscribe(paint);

  slider.addEventListener('input', () => {
    yearIndex = Number(slider.value);
    yearOut.textContent = String(dataset.years[yearIndex]);
    paint();
  });

  // Panning to find one of 241 countries is tedious; jump straight there.
  const search = document.getElementById('search') as HTMLInputElement;
  const list = document.getElementById('search-list') as HTMLDataListElement;
  const byName = new Map<string, string>();
  for (const [iso, c] of Object.entries(dataset.countries)) {
    if (!centroids[iso]) continue;
    byName.set(c.name.toLowerCase(), iso);
    const opt = document.createElement('option');
    opt.value = c.name;
    list.appendChild(opt);
  }

  search.addEventListener('change', () => {
    const iso = byName.get(search.value.trim().toLowerCase());
    const centre = iso ? centroids[iso] : undefined;
    if (centre) {
      map.flyTo(centre);
      search.blur();
      search.value = '';
    }
  });

  document.body.classList.add('ready');
}

boot().catch((err: unknown) => {
  console.error(err);
  const msg = err instanceof Error ? err.message : String(err);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="fatal"><strong>Could not start.</strong><br>${msg}</div>`,
  );
});
