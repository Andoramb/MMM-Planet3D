/* global Log */
import * as THREE from "./vendor/three.module.min.js";

// StarfieldLayer: a "star particles" alternative to the flat night-sky background image - four independent
// Stars point-clouds (see tools/vendor-stars/) nested at increasing radius/decreasing size, mimicking how real
// stars read as a mix of a few bold near ones and many faint distant ones. Attached to the same rotating group
// as the image background (see Earth3DRenderer.js's applyBackground()), so it's swept up by the same
// disposeObject3D() traversal on rebuild - no separate destroy() needed.

// --- Tweak layer count/size/density here ---------------------------------------------------------------------

// radius/depth are globe-radius multiples; count/factor/speed are the baseline that config.starfield's count/size/effectSpeed multiply per layer.
const LAYERS = [
	{ radius: 10, depth: 3, count: 600, factor: 3.0, speed: 0.5 },
	{ radius: 15, depth: 4, count: 1200, factor: 2.0, speed: 0.35 },
	{ radius: 21, depth: 5, count: 2000, factor: 1.3, speed: 0.2 },
	{ radius: 27, depth: 5, count: 2800, factor: 0.8, speed: 0.1 }
];
const BASE_TOTAL_COUNT = LAYERS.reduce((sum, layer) => sum + layer.count, 0);

// stars.mjs's gl_PointSize falloff (30.0 / -mvPosition.z) is calibrated for points ~100 units from the camera; our layers sit globeRadius*layer.radius units out, so factor must scale by that same ratio or points shrink to sub-pixel.
const POINT_SIZE_CALIBRATION_DISTANCE = 100;

// Matches MMM-Earth3D.js's defaults.background.starfield - keep in sync if those change.
const DEFAULT_CONFIG = {
	count: BASE_TOTAL_COUNT,
	size: 1,
	sizeVariation: 0.5,
	color: "#ffffff",
	colorVariation: 0.4,
	fading: true,
	effectVariation: 0,
	effectSpeed: 1
};

// Per-star brightness variance (applied on top of the picked color) so the field isn't uniformly lit.
const MIN_BRIGHTNESS = 0.55;
const MAX_BRIGHTNESS = 1.0;

export class StarfieldLayer {
	// vendor/stars.mjs is hand-patched project code (not a static third-party lib), so it's dynamic-imported with the same cache-bust suffix as this file rather than statically imported - otherwise a browser can keep serving an older cached shader after an update.
	static async create(globeRadius, debug, config, cacheBust) {
		const { Stars } = await import("./vendor/stars.mjs" + (cacheBust || ""));
		return new StarfieldLayer(globeRadius, debug, config, Stars);
	}

	constructor(globeRadius, debug, config, Stars) {
		this.debug = Boolean(debug);
		this.globeRadius = globeRadius;
		this.config = Object.assign({}, DEFAULT_CONFIG, config);
		this.Stars = Stars;
		this.group = new THREE.Group();
		this.layers = LAYERS.map((layer) => this.buildLayer(layer));
		this.layers.forEach((stars) => this.group.add(stars));
		this.debugLog("built", this.layers.length, "layers, config:", this.config);
	}

	debugLog() {
		if (!this.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:StarfieldLayer]"].concat(Array.prototype.slice.call(arguments)));
	}

	buildLayer(layer) {
		const stars = new this.Stars(this.starsOptions(layer));
		this.randomizeColors(stars);
		return stars;
	}

	// Scales this baseline layer's count/factor/speed by the live count/size/effectSpeed multipliers.
	starsOptions(layer) {
		const config = this.config;
		const scale = config.count / BASE_TOTAL_COUNT;
		const distance = this.globeRadius * layer.radius;
		return {
			radius: distance,
			depth: this.globeRadius * layer.depth,
			count: Math.max(1, Math.round(layer.count * scale)),
			factor: layer.factor * config.size * (distance / POINT_SIZE_CALIBRATION_DISTANCE),
			fade: true,
			speed: layer.speed * config.effectSpeed,
			sizeVariation: config.sizeVariation,
			twinkle: config.fading,
			variation: config.effectVariation
		};
	}

	// Live-applies a background.starfield config patch - rebuilds every layer's attributes since position/size/phase all depend on count/size/etc.
	setConfig(config) {
		this.config = Object.assign({}, this.config, config);
		this.debugLog("setConfig", this.config);
		this.layers.forEach((stars, index) => {
			stars.rebuildAttributes(this.starsOptions(LAYERS[index]));
			this.randomizeColors(stars);
		});
	}

	// Overwrites Stars' own index-cycled hue with the picked base color, jittered per star by colorVariation.
	randomizeColors(stars) {
		const colorAttr = stars.geometry.attributes.color;
		const base = new THREE.Color(this.config.color);
		const baseHsl = base.getHSL({});
		const variation = this.config.colorVariation;
		const color = new THREE.Color();
		for (let i = 0; i < colorAttr.count; i++) {
			const brightness = MIN_BRIGHTNESS + Math.random() * (MAX_BRIGHTNESS - MIN_BRIGHTNESS);
			const hue = (baseHsl.h + (Math.random() - 0.5) * variation + 1) % 1;
			const saturation = Math.min(1, baseHsl.s + Math.random() * variation);
			color.setHSL(hue, saturation, baseHsl.l).multiplyScalar(brightness);
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
