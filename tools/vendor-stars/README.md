# Vendoring @pmndrs/vanilla's Stars

`public/vendor/stars.mjs` is not a hand-download - it's produced by
`build.mjs` in this directory, which bundles `@pmndrs/vanilla`'s `Stars`
class (a shader-based point-cloud starfield, maintained by the pmndrs/drei
team with no React dependency) with esbuild, leaving only its `"three"`
import external (rewritten to the relative path `./three.module.min.js`,
matching MMM-Earth3D's own vendored Three.js build under `public/vendor/`).

## Regenerating (e.g. after a version bump)

```sh
cd tools/vendor-stars
npm install --no-save @pmndrs/vanilla@1.25.0 three@0.185.0 esbuild
node build.mjs
```

This overwrites `public/vendor/stars.mjs` directly - no manual patching
needed afterward. Make sure the `three@` version installed here matches (or
is compatible with) whatever revision `public/vendor/three.module.min.js` /
`three.core.min.js` actually are, since `Stars` must run against the exact
same Three.js instance as the rest of the module (see `StarfieldLayer.mjs`,
which imports that same file).

`node_modules` created by the `npm install` above is disposable - it's
already covered by the repo's root `.gitignore` (`node_modules/` matches at
any depth) and isn't needed after `build.mjs` has run.

## Hand patch: sizeVariation/twinkle/variation

`public/vendor/stars.mjs` no longer matches `build.mjs`'s raw output - it's
hand-patched (and de-minified) to add `sizeVariation`, `twinkle`, and
`variation` constructor/`rebuildAttributes` options plus a `phase` per-star
attribute, so `StarfieldLayer.mjs` can drive MMM-Earth3D's Star Particles
live controls. Re-running `build.mjs` overwrites that patch - if you
regenerate, reapply it from git history (or copy `stars.mjs`'s current
contents over the freshly-generated file's `import`/class bodies) before
committing.
