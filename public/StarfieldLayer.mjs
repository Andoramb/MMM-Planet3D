/* global Log */
import * as THREE from "./vendor/three.module.min.js";
import { Stars } from "./vendor/stars.mjs";

// StarfieldLayer: a "star particles" alternative to the flat night-sky background image - four independent
// Stars point-clouds (see tools/vendor-stars/) nested at increasing radius/decreasing size, mimicking how real
// stars read as a mix of a few bold near ones and many faint distant ones. Attached to the same rotating group
// as the image background (see Earth3DRenderer.js's applyBackground()), so it's swept up by the same
// disposeObject3D() traversal on rebuild - no separate destroy() needed.

// --- Tweak layer count/size/density here ---------------------------------------------------------------------

// radius/depth are globe-radius multiples; each layer is a spherical shell from radius to radius+depth.
// count/factor/speed shrink from near to far so the nearest layer reads as a handful of bold, slow-twinkling
// stars and the farthest as a dense, faint, fast-twinkling haze - the classic parallax-depth trick.
const LAYERS = [
	{ radius: 10, depth: 3, count: 600, factor: 3.0, speed: 0.5 },
	{ radius: 15, depth: 4, count: 1200, factor: 2.0, speed: 0.35 },
	{ radius: 21, depth: 5, count: 2000, factor: 1.3, speed: 0.2 },
	{ radius: 27, depth: 5, count: 2800, factor: 0.8, speed: 0.1 }
];

// Real starlight reads mostly white/blue-white with occasional warm (K/M-class) stars - a weighted palette
// beats Stars' own built-in color (an index-cycled hue ramp, which looks like a rainbow gradient, not a sky).
const COLOR_PALETTE = [
	{ color: 0xffffff, weight: 55 },
	{ color: 0xcfe3ff, weight: 22 },
	{ color: 0xfff2d9, weight: 15 },
	{ color: 0xffd0a0, weight: 8 }
];
const PALETTE_TOTAL_WEIGHT = COLOR_PALETTE.reduce((sum, entry) => sum + entry.weight, 0);

// Per-star brightness variance (applied on top of the picked color) so the field isn't uniformly lit.
const MIN_BRIGHTNESS = 0.55;
const MAX_BRIGHTNESS = 1.0;

function pickPaletteColor() {
	let roll = Math.random() * PALETTE_TOTAL_WEIGHT;
	for (const entry of COLOR_PALETTE) {
		roll -= entry.weight;
		if (roll <= 0) {
			return entry.color;
		}
	}
	return COLOR_PALETTE[COLOR_PALETTE.length - 1].color;
}

export class StarfieldLayer {
	constructor(globeRadius, debug) {
		this.debug = Boolean(debug);
		this.group = new THREE.Group();
		this.layers = LAYERS.map((layer) => this.buildLayer(globeRadius, layer));
		this.layers.forEach((stars) => this.group.add(stars));
		this.debugLog("built", this.layers.length, "layers, total stars:", LAYERS.reduce((sum, l) => sum + l.count, 0));
	}

	debugLog() {
		if (!this.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:StarfieldLayer]"].concat(Array.prototype.slice.call(arguments)));
	}

	buildLayer(globeRadius, layer) {
		const stars = new Stars({
			radius: globeRadius * layer.radius,
			depth: globeRadius * layer.depth,
			count: layer.count,
			factor: layer.factor,
			fade: true,
			speed: layer.speed
		});
		this.randomizeColors(stars);
		return stars;
	}

	// Overwrites Stars' own index-cycled hue with a randomized realistic palette plus per-star brightness -
	// both attributes are plain public BufferAttributes, so this needs no fork of the vendored shader/class.
	randomizeColors(stars) {
		const colorAttr = stars.geometry.attributes.color;
		const color = new THREE.Color();
		for (let i = 0; i < colorAttr.count; i++) {
			const brightness = MIN_BRIGHTNESS + Math.random() * (MAX_BRIGHTNESS - MIN_BRIGHTNESS);
			color.set(pickPaletteColor()).multiplyScalar(brightness);
			colorAttr.setXYZ(i, color.r, color.g, color.b);
		}
		colorAttr.needsUpdate = true;
	}

	attachTo(parentObject3D) {
		if (this.group.parent !== parentObject3D) {
			parentObject3D.add(this.group);
		}
	}

	setVisible(visible) {
		this.group.visible = visible;
	}

	tick(now) {
		const elapsedSeconds = now / 1000;
		this.layers.forEach((stars) => stars.update(elapsedSeconds));
	}
}
