/* global Log */
import * as THREE from "./vendor/three.module.min.js";

/*
 * CloudsLayer
 * A second, slightly larger sphere sitting just above the globe surface,
 * carrying the clouds texture and rotating independently for a parallax
 * effect - unlike Earth3DRenderer's other assets, this needs real Three.js
 * geometry (not the canvas-compositing trick EarthCompositor uses for
 * day/night), so it's its own ES module importing a separately-vendored
 * Three.js build. This mirrors the technique in three-globe's own official
 * example: https://github.com/vasturiano/three-globe/tree/master/example/clouds
 *
 * This is loaded via a dynamic import(), not MM's getScripts() - MM core's
 * own loader only handles a fixed set of file extensions ("js"/"css" in
 * older core versions, "js"/"css"/"mjs" in newer ones with no default case
 * either way), so a plain <script type="module"> tag it inserts for an
 * unrecognized extension can silently no-op on some MM versions with no
 * error at all. A browser-native dynamic import() bypasses MM's loader
 * entirely and works the same on every MM core version - see
 * Earth3DRenderer.js's ensureCloudsLayer().
 */

// --- Tweak clouds size and rotation speed here -------------------------

// How far above the globe surface the clouds sphere sits, as a fraction of
// the globe's radius (0.006 = 0.6% larger). Bigger = clouds visibly float
// above the surface instead of hugging it; too big looks like a separate
// planet. Matches the scale used in three-globe's own clouds example.
const CLOUDS_ALTITUDE = 0.006;

// Clouds' own rotation, in degrees/second, relative to the globe they're
// attached to (i.e. on top of whatever the globe itself is doing - spin,
// tilt, etc). Small values drift slowly for a subtle parallax feel.
const CLOUDS_ROTATION_SPEED_X_DEG_PER_SEC = 0.3;
const CLOUDS_ROTATION_SPEED_Y_DEG_PER_SEC = 0.5;

// Slowly wanders each axis' speed up/down over time instead of a perfectly
// constant drift, so the clouds feel a bit more alive without being
// distracting. 0 = no variation (back to constant speed); 0.4 = speed
// wanders between 60% and 140% of the base value above. Periods are in
// seconds and deliberately different (and phase-offset) per axis so the two
// don't fall in/out of sync with each other in an obviously repeating way.
const CLOUDS_SPEED_VARIATION = 0.4;
const CLOUDS_VARIATION_PERIOD_X_SEC = 95;
const CLOUDS_VARIATION_PERIOD_Y_SEC = 140;
const CLOUDS_VARIATION_PHASE_Y = Math.PI / 3;

const SPHERE_SEGMENTS = 75;

/*
 * Night-side darkening (see setNightMask() below) is applied as a shader
 * effect on this SAME mesh, rather than a second sphere - an earlier version
 * of this file used a separate, non-rotating "shade" sphere sitting just
 * above the clouds, but two near-coincident transparent spheres z-fight
 * (the depth buffer can't reliably tell them apart at that tiny gap), which
 * showed up as visible flicker/tearing between the two layers.
 *
 * The real difficulty this shader solves: the mask EarthCompositor builds is
 * correct in *geographic* terms (a small equirectangular canvas, the same
 * projection the clouds texture itself uses) - but it needs to land on the
 * geographic point each fragment is CURRENTLY covering, not the point its
 * texture coordinate corresponds to at rest. Since this mesh's own rotation
 * (tick() below) is layered independently on top of the globe's shared
 * spin/tilt purely for the parallax look, a fragment's UV drifts relative to
 * geography over time - sampling the mask directly by UV would reproduce the
 * exact drift bug this file used to have. Instead, each fragment's raw
 * (rotation-invariant) object-space normal is rotated by this mesh's current
 * accumulated rotation (a plain 3x3 uniform, updated once per frame in
 * tick() - cheap, done once per frame rather than per pixel) before being
 * converted back to (lat, lng) and used to sample the mask - which is
 * exactly "where is this fragment over the Earth right now", regardless of
 * how long the clouds have been drifting.
 */
const NIGHT_MASK_VERTEX_INJECT = {
	common: "#include <common>\nvarying vec3 vCloudObjectNormal;",
	beginnormal_vertex: "#include <beginnormal_vertex>\nvCloudObjectNormal = objectNormal;"
};
const NIGHT_MASK_FRAGMENT_INJECT = {
	common: `#include <common>
		uniform mat3 cloudRotation;
		uniform sampler2D nightMask;
		uniform float nightMaskEnabled;
		varying vec3 vCloudObjectNormal;`,
	map_fragment: `#include <map_fragment>
		if ( nightMaskEnabled > 0.5 ) {
			vec3 correctedNormal = normalize( cloudRotation * vCloudObjectNormal );
			float lng = atan( -correctedNormal.z, correctedNormal.x );
			float lat = asin( clamp( correctedNormal.y, -1.0, 1.0 ) );
			vec2 maskUv = vec2( lng / ( 2.0 * 3.14159265358979 ) + 0.5, 0.5 - lat / 3.14159265358979 );
			float nightAmount = texture2D( nightMask, maskUv ).a;
			diffuseColor.rgb *= ( 1.0 - nightAmount );
		}`
};

export class CloudsLayer {
	constructor(globeRadius, debug) {
		this.globeRadius = globeRadius;
		this.debug = Boolean(debug);
		this.mesh = null;
		this.shader = null;
		this.nightMaskTexture = null;
		this.lastFrameTime = null;
	}

	debugLog() {
		if (!this.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:CloudsLayer]"].concat(Array.prototype.slice.call(arguments)));
	}

	// Builds the mesh on first call; later calls just swap the texture
	// image (e.g. a fresh GIBS fetch) without rebuilding geometry/material.
	setTexture(image) {
		if (!this.mesh) {
			const geometry = new THREE.SphereGeometry(this.globeRadius * (1 + CLOUDS_ALTITUDE), SPHERE_SEGMENTS, SPHERE_SEGMENTS);
			const texture = new THREE.Texture(image);
			texture.needsUpdate = true;
			const material = new THREE.MeshPhongMaterial({ map: texture, transparent: true, opacity: 1 });
			material.onBeforeCompile = (shader) => this.onMaterialCompile(shader);
			this.mesh = new THREE.Mesh(geometry, material);
			return;
		}
		this.mesh.material.map.dispose();
		this.mesh.material.map = new THREE.Texture(image);
		this.mesh.material.map.needsUpdate = true;
	}

	// Injects the night-mask darkening logic (see the comment above) into
	// the material's regular Phong shader - keeps normal Phong lighting for
	// the plain "clouds, no day/night" look, only modulating brightness on
	// top of it. Runs once (or again if the material ever needs recompiling,
	// e.g. after toggling features that change its #defines) - the uniforms
	// object is stashed on `this.shader` so setNightMask()/tick() can update
	// their values every frame without needing a recompile.
	onMaterialCompile(shader) {
		shader.uniforms.cloudRotation = { value: new THREE.Matrix3() };
		shader.uniforms.nightMask = { value: this.nightMaskTexture || new THREE.DataTexture(new Uint8Array(4), 1, 1) };
		shader.uniforms.nightMaskEnabled = { value: this.nightMaskTexture ? 1 : 0 };
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", NIGHT_MASK_VERTEX_INJECT.common)
			.replace("#include <beginnormal_vertex>", NIGHT_MASK_VERTEX_INJECT.beginnormal_vertex);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", NIGHT_MASK_FRAGMENT_INJECT.common)
			.replace("#include <map_fragment>", NIGHT_MASK_FRAGMENT_INJECT.map_fragment);
		this.shader = shader;
		this.debugLog("material compiled, nightMaskEnabled:", shader.uniforms.nightMaskEnabled.value, "had pending mask:", Boolean(this.nightMaskTexture));
	}

	// image is a small black/transparent alpha mask from EarthCompositor
	// (transparent on the day side, translucent black on the night side, in
	// the same equirectangular projection the clouds texture itself uses),
	// or null to turn the effect off entirely (dayNight disabled).
	setNightMask(image) {
		this.debugLog("setNightMask", Boolean(image), "shader ready:", Boolean(this.shader));
		if (this.nightMaskTexture) {
			this.nightMaskTexture.dispose();
			this.nightMaskTexture = null;
		}
		if (!image) {
			if (this.shader) {
				this.shader.uniforms.nightMaskEnabled.value = 0;
			}
			return;
		}
		this.nightMaskTexture = new THREE.CanvasTexture(image);
		// The mask's (lng) coordinate is derived per-fragment via atan2 (see
		// onMaterialCompile()'s shader chunk), which wraps at +-180 deg - without
		// this the seam there would show as a hard line instead of wrapping
		// smoothly.
		this.nightMaskTexture.wrapS = THREE.RepeatWrapping;
		if (this.shader) {
			this.shader.uniforms.nightMask.value = this.nightMaskTexture;
			this.shader.uniforms.nightMaskEnabled.value = 1;
		}
	}

	setOpacity(opacity) {
		if (this.mesh) {
			this.mesh.material.opacity = opacity;
		}
	}

	setVisible(visible) {
		if (this.mesh) {
			this.mesh.visible = visible;
		}
	}

	attachTo(parentObject3D) {
		if (this.mesh && this.mesh.parent !== parentObject3D) {
			parentObject3D.add(this.mesh);
		}
	}

	tick(now) {
		if (!this.mesh) {
			return;
		}
		const deltaSeconds = this.lastFrameTime !== null ? (now - this.lastFrameTime) / 1000 : 0;
		this.lastFrameTime = now;

		const nowSec = now / 1000;
		const speedX = CLOUDS_ROTATION_SPEED_X_DEG_PER_SEC
			* (1 + CLOUDS_SPEED_VARIATION * Math.sin((2 * Math.PI * nowSec) / CLOUDS_VARIATION_PERIOD_X_SEC));
		const speedY = CLOUDS_ROTATION_SPEED_Y_DEG_PER_SEC
			* (1 + CLOUDS_SPEED_VARIATION * Math.sin((2 * Math.PI * nowSec) / CLOUDS_VARIATION_PERIOD_Y_SEC + CLOUDS_VARIATION_PHASE_Y));

		this.mesh.rotation.x += (speedX * Math.PI / 180) * deltaSeconds;
		this.mesh.rotation.y += (speedY * Math.PI / 180) * deltaSeconds;

		// Keeps the night mask locked to true geography (see the comment
		// above onMaterialCompile()) regardless of the independent parallax
		// spin just applied above - cheap (once per frame, not per pixel).
		if (this.shader) {
			this.shader.uniforms.cloudRotation.value.setFromMatrix4(
				new THREE.Matrix4().makeRotationFromEuler(this.mesh.rotation)
			);
		}
	}

	destroy() {
		if (this.nightMaskTexture) {
			this.nightMaskTexture.dispose();
			this.nightMaskTexture = null;
		}
		if (this.mesh) {
			this.mesh.geometry.dispose();
			if (this.mesh.material.map) {
				this.mesh.material.map.dispose();
			}
			this.mesh.material.dispose();
			if (this.mesh.parent) {
				this.mesh.parent.remove(this.mesh);
			}
			this.mesh = null;
		}
		this.shader = null;
	}
}
window.CloudsLayer = CloudsLayer;
