import maplibregl, { type Map as MLMap, type MapGeoJSONFeature } from 'maplibre-gl';
import { Signal } from '../lens/reactive';

/**
 * OpenFreeMap serves OSM-derived vector tiles with no key and no rate limit.
 * The 'liberty' style is a full basemap; we strip it back in `quietStyle` so
 * the map reads as context rather than competing with the lens.
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * The country under the crosshair. MapLibre's basemap tiles do carry country
 * polygons, but their boundary layers are styled for labels, not hit-testing,
 * so we render our own country fill layer from a lightweight GeoJSON and query
 * that instead. It doubles as the highlight layer.
 */
export interface MapLayerOptions {
  container: HTMLElement;
  /** URL of a country polygons GeoJSON with an ISO_A3 property. */
  countriesUrl: string;
  center?: [number, number];
  zoom?: number;
}

export class MapLayer {
  readonly map: MLMap;
  /** ISO3 of the country under the viewport centre, or null over water. */
  readonly focus = new Signal<string | null>(null);
  private ready = false;

  constructor(private opts: MapLayerOptions) {
    this.map = new maplibregl.Map({
      container: opts.container,
      style: STYLE_URL,
      center: opts.center ?? [10, 30],
      zoom: opts.zoom ?? 3.2,
      minZoom: 1.6,
      maxZoom: 7,
      attributionControl: { compact: true },
      // The lens sits at the viewport centre and reads what is under it, so a
      // tilted or rotated camera would make "the centre" ambiguous.
      pitchWithRotate: false,
      dragRotate: false,
      touchZoomRotate: false,
    });

    this.map.on('load', () => void this.onLoad());
  }

  private async onLoad(): Promise<void> {
    this.quietStyle();

    // generateId is off on purpose: the build script assigns each feature a
    // stable numeric id, and setFeatureState needs ids that survive reloads.
    this.map.addSource('countries', { type: 'geojson', data: this.opts.countriesUrl });

    // Transparent fill: invisible, but queryable and it anchors the highlight.
    this.map.addLayer({
      id: 'country-hit',
      type: 'fill',
      source: 'countries',
      paint: { 'fill-color': '#000', 'fill-opacity': 0 },
    });

    this.map.addLayer({
      id: 'country-active-fill',
      type: 'fill',
      source: 'countries',
      paint: {
        'fill-color': '#7dd3fc',
        'fill-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.16, 0],
      },
    });

    this.map.addLayer({
      id: 'country-active-line',
      type: 'line',
      source: 'countries',
      paint: {
        'line-color': '#7dd3fc',
        'line-width': ['case', ['boolean', ['feature-state', 'active'], false], 1.6, 0],
        'line-opacity': 0.9,
      },
    });

    this.ready = true;

    // Sampling on 'move' rather than 'moveend' is what makes the lens track
    // the pan continuously instead of snapping when the gesture ends.
    this.map.on('move', this.sample);
    this.map.on('sourcedata', (e) => {
      if (e.sourceId === 'countries' && e.isSourceLoaded) this.sample();
    });
    this.sample();
  }

  /**
   * Tone the basemap down: it is context for the lens, not the subject.
   *
   * Only street-level furniture is removed. Landcover and landuse stay: in the
   * Liberty style they carry the land fill itself, and dropping them leaves a
   * bare hillshade with no countries visible. Everything else is dimmed via
   * paint properties rather than deleted, which keeps the map legible.
   */
  private quietStyle(): void {
    const style = this.map.getStyle();
    for (const layer of style.layers ?? []) {
      const id = layer.id;

      // Detail that only means anything when zoomed into a street.
      if (/^(poi|building|transit|aeroway|bridge|tunnel)/i.test(id)) {
        if (this.map.getLayer(id)) this.map.removeLayer(id);
        continue;
      }

      // Keep country and continent names; drop the rest of the label noise.
      if (layer.type === 'symbol') {
        if (!/label_country|label_continent/i.test(id)) {
          if (this.map.getLayer(id)) this.map.removeLayer(id);
          continue;
        }
      }

      // Roads survive as faint texture rather than a highway network.
      if (/^(highway|road)/i.test(id) && layer.type === 'line') {
        this.trySetPaint(id, 'line-opacity', 0.18);
      }

      // Boundaries are the one basemap feature the lens depends on.
      if (/^boundary/i.test(id)) {
        this.trySetPaint(id, 'line-opacity', 0.5);
      }
    }
  }

  /** Paint keys vary by style version; a missing one must not kill the load. */
  private trySetPaint(id: string, key: string, value: unknown): void {
    try {
      this.map.setPaintProperty(id, key, value);
    } catch {
      /* layer does not support this property in this style */
    }
  }

  private lastFocus: string | null = null;
  private lastFeatureId: string | number | undefined;

  private sample = (): void => {
    if (!this.ready) return;
    const centre = this.map.project(this.map.getCenter());
    let hits: MapGeoJSONFeature[] = [];
    try {
      hits = this.map.queryRenderedFeatures(centre, { layers: ['country-hit'] });
    } catch {
      return; // Source not ready yet; a later sourcedata event will retry.
    }

    const hit = hits[0];
    const iso = (hit?.properties?.['ISO_A3'] as string | undefined) ?? null;

    if (iso === this.lastFocus) return;
    this.lastFocus = iso;

    if (this.lastFeatureId !== undefined) {
      this.map.setFeatureState({ source: 'countries', id: this.lastFeatureId }, { active: false });
      this.lastFeatureId = undefined;
    }
    if (hit && hit.id !== undefined) {
      this.lastFeatureId = hit.id;
      this.map.setFeatureState({ source: 'countries', id: hit.id }, { active: true });
    }

    this.focus.set(iso);
  };

  flyTo(centre: [number, number]): void {
    this.map.flyTo({ center: centre, duration: 1400, essential: true });
  }
}
