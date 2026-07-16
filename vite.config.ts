import { defineConfig } from 'vite';

/**
 * On GitHub Pages the app is served from a subpath (/datavis/), not the
 * domain root, so absolute asset URLs would 404. `base: './'` makes the
 * built HTML reference its assets relatively, which works both there and
 * from a local `vite preview`.
 */
export default defineConfig({
  base: './',
  build: {
    // MapLibre alone is ~1 MB; the default 500 kB warning is just noise here.
    chunkSizeWarningLimit: 1200,
  },
});
