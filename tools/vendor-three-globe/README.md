# Vendoring three-globe

`public/vendor/three-globe.mjs` is not a hand-download of an official
three-globe build - it's produced by `build.mjs` in this directory, which
bundles three-globe's published ESM entry point with esbuild, leaving only
its core `"three"` import external (rewritten to the relative path
`./three.module.min.js`, matching MMM-Earth3D's own vendored Three.js build
under `public/vendor/`) and stubbing out three-globe's optional WebGPU render
path (`three/webgpu`/`three/tsl`), which MMM-Earth3D never uses. See the
comment block at the top of `build.mjs` for why.

## Regenerating (e.g. after a three-globe version bump)

```sh
cd tools/vendor-three-globe
npm install --no-save three-globe@^2.45 three@0.185.0 esbuild
node build.mjs
```

This overwrites `public/vendor/three-globe.mjs` directly - no manual patching
needed afterward. Make sure the `three@` version installed here matches (or
is compatible with) whatever revision `public/vendor/three.module.min.js` /
`three.core.min.js` actually are, since three-globe's code must run against
the exact same Three.js instance as the rest of the module (see
`Earth3DRenderer.js` and `CloudsLayer.mjs`, which both import that same file).

`node_modules` created by the `npm install` above is disposable - it's
already covered by the repo's root `.gitignore` (`node_modules/` matches at
any depth) and isn't needed after `build.mjs` has run.
