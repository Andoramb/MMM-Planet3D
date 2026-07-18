/* global Log */
import * as THREE from "./vendor/three.module.min.js";

// CloudsLayer: a second sphere above the globe carrying the clouds texture, rotating independently for parallax - real Three.js geometry, loaded via dynamic import() (see Earth3DRenderer.js's ensureCloudsLayer()).

// --- Tweak clouds size and rotation speed here -------------------------

// Fraction of globe radius the clouds sphere floats above the surface.
const CLOUDS_ALTITUDE = 0.006;

// Clouds' own rotation in degrees/second, layered on top of the globe's own spin/tilt.
const CLOUDS_ROTATION_SPEED_X_DEG_PER_SEC = 0.3;
const CLOUDS_ROTATION_SPEED_Y_DEG_PER_SEC = 0.5;

// Wanders each axis' speed 60%-140% of base over time (0 = constant) so the drift feels a bit alive; periods are phase-offset per axis to avoid an obvious repeating sync.
const CLOUDS_SPEED_VARIATION = 0.4;
const CLOUDS_VARIATION_PERIOD_X_SEC = 95;
const CLOUDS_VARIATION_PERIOD_Y_SEC = 140;
const CLOUDS_VARIATION_PHASE_Y = Math.PI / 3;

const SPHERE_SEGMENTS = 75;

// three-globe's globe mesh applies rotation.y = -PI/2 internally; this mesh doesn't, so the shader's lat/lng derivation needs the inverse +PI/2 correction or the night mask ends up rotated 90deg (verified numerically).
const GLOBE_ALIGNMENT_ROTATION_Y = Math.PI / 2;

// --- Dynamic mode ("clouds.source": "dynamic") --------------------------
// Adds a second, fainter high-altitude sphere plus a per-pixel UV scroll/noise-warp on both layers, so the (still static Blue Marble) texture visibly drifts and billows instead of riding along as a rigid decal. Off by default - "static"/"realtime" render exactly as before.

const DYNAMIC_HIGH_ALTITUDE = 0.026; // fraction of globe radius the high layer floats above the surface
const DYNAMIC_HIGH_OPACITY_FACTOR = 0.45; // relative to the current clouds opacity

const DYNAMIC_HIGH_ROTATION_SPEED_X_DEG_PER_SEC = 0.45;
const DYNAMIC_HIGH_ROTATION_SPEED_Y_DEG_PER_SEC = -0.35; // opposite sign from the base layer so the two visibly slide against each other

// Per-pixel UV scroll (texture-space units/sec), independent of mesh rotation - drifts the cloud pattern itself rather than just spinning the sphere it's painted on.
const DYNAMIC_SCROLL = { base: { u: 0.004, v: 0.0015 }, high: { u: -0.006, v: 0.002 } };

// Domain-warp noise: displaces the sample UV by a small, slowly-evolving amount so cloud shapes visibly billow rather than translate rigidly. Kept subtle on purpose - a hint of life, not a storm.
const DYNAMIC_WARP_SCALE = 3.5; // noise frequency across the 0-1 UV range
const DYNAMIC_WARP_SPEED = 0.025; // how fast the noise field itself evolves
const DYNAMIC_WARP_STRENGTH = 0.01; // max UV displacement
const DYNAMIC_WARP_SEED = { base: 0, high: 37 }; // decorrelates the two layers' warp so they don't billow in lockstep

const NOISE_GLSL = `
	float mmmHash21(vec2 p) {
		p = fract(p * vec2(123.34, 456.21));
		p += dot(p, p + 45.32);
		return fract(p.x * p.y);
	}
	float mmmValueNoise(vec2 p) {
		vec2 i = floor(p);
		vec2 f = fract(p);
		float a = mmmHash21(i);
		float b = mmmHash21(i + vec2(1.0, 0.0));
		float c = mmmHash21(i + vec2(0.0, 1.0));
		float d = mmmHash21(i + vec2(1.0, 1.0));
		vec2 u = f * f * (3.0 - 2.0 * f);
		return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
	}
`;

const DYNAMIC_UNIFORMS_GLSL = `
	uniform float uTime;
	uniform float dynamicEnabled;
	uniform vec2 dynamicScrollSpeed;
	uniform float dynamicWarpSeed;
`;

// Mutates vMapUv before <map_fragment> samples it - scroll + noise-warp only kick in once dynamicEnabled is set (see setDynamic()).
const DYNAMIC_MAP_FRAGMENT_INJECT = `
	if ( dynamicEnabled > 0.5 ) {
		vec2 warpP = vMapUv * ${DYNAMIC_WARP_SCALE.toFixed(2)} + dynamicWarpSeed + uTime * ${DYNAMIC_WARP_SPEED.toFixed(4)};
		float n1 = mmmValueNoise( warpP );
		float n2 = mmmValueNoise( warpP * 2.0 + 19.0 );
		vec2 warpOffset = ( vec2( n1, n2 ) - 0.5 ) * ${DYNAMIC_WARP_STRENGTH.toFixed(4)};
		vMapUv = vMapUv + dynamicScrollSpeed * uTime + warpOffset;
	}
	#include <map_fragment>
`;

// Night-side darkening is a shader effect on this same mesh (a second near-coincident sphere z-fights) - each fragment's rotation-invariant object-space normal is re-rotated by the mesh's current spin before sampling EarthCompositor's geographic mask, so the mask tracks true geography despite the independent parallax spin.
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
	map_fragment: `${DYNAMIC_MAP_FRAGMENT_INJECT}
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
		this.highMesh = null;
		this.shader = null;
		this.highShader = null;
		this.nightMaskTexture = null;
		this.lastFrameTime = null;
		this.currentImage = null;
		this.dynamicMode = false;
		this.opacity = 1;
		this.visible = true;
	}

	debugLog() {
		if (!this.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:CloudsLayer]"].concat(Array.prototype.slice.call(arguments)));
	}

	// Builds the mesh on first call; later calls just swap the texture image without rebuilding geometry/material.
	setTexture(image) {
		this.currentImage = image;
		if (!this.mesh) {
			const geometry = new THREE.SphereGeometry(this.globeRadius * (1 + CLOUDS_ALTITUDE), SPHERE_SEGMENTS, SPHERE_SEGMENTS);
			const texture = new THREE.Texture(image);
			texture.wrapS = THREE.RepeatWrapping;
			texture.needsUpdate = true;
			const material = new THREE.MeshPhongMaterial({ map: texture, transparent: true, opacity: 1 });
			material.onBeforeCompile = (shader) => this.onMaterialCompile(shader);
			this.mesh = new THREE.Mesh(geometry, material);
		} else {
			this.mesh.material.map.dispose();
			this.mesh.material.map = new THREE.Texture(image);
			this.mesh.material.map.wrapS = THREE.RepeatWrapping;
			this.mesh.material.map.needsUpdate = true;
		}
		if (this.highMesh) {
			this.highMesh.material.map.dispose();
			this.highMesh.material.map = new THREE.Texture(image);
			this.highMesh.material.map.wrapS = THREE.RepeatWrapping;
			this.highMesh.material.map.needsUpdate = true;
		}
	}

	// Injects the night-mask + dynamic-warp shader logic into the material's Phong shader; uniforms are stashed on `this.shader` so setNightMask()/setDynamic()/tick() can update them without recompiling.
	onMaterialCompile(shader) {
		shader.uniforms.cloudRotation = { value: new THREE.Matrix3() };
		shader.uniforms.nightMask = { value: this.nightMaskTexture || new THREE.DataTexture(new Uint8Array(4), 1, 1) };
		shader.uniforms.nightMaskEnabled = { value: this.nightMaskTexture ? 1 : 0 };
		shader.uniforms.uTime = { value: 0 };
		shader.uniforms.dynamicEnabled = { value: this.dynamicMode ? 1 : 0 };
		shader.uniforms.dynamicScrollSpeed = { value: new THREE.Vector2(DYNAMIC_SCROLL.base.u, DYNAMIC_SCROLL.base.v) };
		shader.uniforms.dynamicWarpSeed = { value: DYNAMIC_WARP_SEED.base };
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", NIGHT_MASK_VERTEX_INJECT.common)
			.replace("#include <beginnormal_vertex>", NIGHT_MASK_VERTEX_INJECT.beginnormal_vertex);
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", NIGHT_MASK_FRAGMENT_INJECT.common + "\n" + DYNAMIC_UNIFORMS_GLSL + NOISE_GLSL)
			.replace("#include <map_fragment>", NIGHT_MASK_FRAGMENT_INJECT.map_fragment);
		this.shader = shader;
		this.debugLog("material compiled, nightMaskEnabled:", shader.uniforms.nightMaskEnabled.value, "had pending mask:", Boolean(this.nightMaskTexture));
	}

	// High-altitude dynamic layer's shader has no night mask (faint/high, already reads fine unlit) - just the warp/scroll.
	onHighMaterialCompile(shader) {
		shader.uniforms.uTime = { value: 0 };
		shader.uniforms.dynamicEnabled = { value: 1 };
		shader.uniforms.dynamicScrollSpeed = { value: new THREE.Vector2(DYNAMIC_SCROLL.high.u, DYNAMIC_SCROLL.high.v) };
		shader.uniforms.dynamicWarpSeed = { value: DYNAMIC_WARP_SEED.high };
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", "#include <common>\n" + DYNAMIC_UNIFORMS_GLSL + NOISE_GLSL)
			.replace("#include <map_fragment>", DYNAMIC_MAP_FRAGMENT_INJECT);
		this.highShader = shader;
	}

	// Lazily builds the second, fainter high-altitude sphere the first time dynamic mode turns on.
	ensureHighLayer() {
		if (this.highMesh || !this.currentImage) {
			return;
		}
		const geometry = new THREE.SphereGeometry(this.globeRadius * (1 + DYNAMIC_HIGH_ALTITUDE), SPHERE_SEGMENTS, SPHERE_SEGMENTS);
		const texture = new THREE.Texture(this.currentImage);
		texture.wrapS = THREE.RepeatWrapping;
		texture.needsUpdate = true;
		const material = new THREE.MeshPhongMaterial({
			map: texture,
			transparent: true,
			opacity: this.opacity * DYNAMIC_HIGH_OPACITY_FACTOR,
			depthWrite: false
		});
		material.onBeforeCompile = (shader) => this.onHighMaterialCompile(shader);
		this.highMesh = new THREE.Mesh(geometry, material);
		this.highMesh.visible = this.dynamicMode && this.visible;
		if (this.mesh && this.mesh.parent) {
			this.mesh.parent.add(this.highMesh);
		}
	}

	// image is EarthCompositor's small day/night alpha mask (same equirectangular projection as the clouds texture), or null to disable the effect.
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
		// The mask's per-fragment lng (via atan2) wraps at +-180deg, so it needs RepeatWrapping to avoid a hard seam.
		this.nightMaskTexture.wrapS = THREE.RepeatWrapping;
		if (this.shader) {
			this.shader.uniforms.nightMask.value = this.nightMaskTexture;
			this.shader.uniforms.nightMaskEnabled.value = 1;
		}
	}

	// enabled = true for "clouds.source": "dynamic" - adds the high layer and turns on the scroll/warp shader path on both layers.
	setDynamic(enabled) {
		this.dynamicMode = Boolean(enabled);
		if (this.shader) {
			this.shader.uniforms.dynamicEnabled.value = this.dynamicMode ? 1 : 0;
		}
		if (this.dynamicMode) {
			this.ensureHighLayer();
		}
		if (this.highMesh) {
			this.highMesh.visible = this.dynamicMode && this.visible;
		}
	}

	setOpacity(opacity) {
		this.opacity = opacity;
		if (this.mesh) {
			this.mesh.material.opacity = opacity;
		}
		if (this.highMesh) {
			this.highMesh.material.opacity = opacity * DYNAMIC_HIGH_OPACITY_FACTOR;
		}
	}

	setVisible(visible) {
		this.visible = visible;
		if (this.mesh) {
			this.mesh.visible = visible;
		}
		if (this.highMesh) {
			this.highMesh.visible = this.dynamicMode && visible;
		}
	}

	attachTo(parentObject3D) {
		if (this.mesh && this.mesh.parent !== parentObject3D) {
			parentObject3D.add(this.mesh);
		}
		if (this.highMesh && this.highMesh.parent !== parentObject3D) {
			parentObject3D.add(this.highMesh);
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

		// Keeps the night mask locked to true geography despite the parallax spin - composed with GLOBE_ALIGNMENT_ROTATION_Y to match three-globe's internal globe rotation.
		if (this.shader) {
			const spinMatrix = new THREE.Matrix4().makeRotationFromEuler(this.mesh.rotation);
			const alignmentMatrix = new THREE.Matrix4().makeRotationY(GLOBE_ALIGNMENT_ROTATION_Y);
			this.shader.uniforms.cloudRotation.value.setFromMatrix4(alignmentMatrix.multiply(spinMatrix));
			this.shader.uniforms.uTime.value = nowSec;
		}

		if (this.highMesh) {
			this.highMesh.rotation.x += (DYNAMIC_HIGH_ROTATION_SPEED_X_DEG_PER_SEC * Math.PI / 180) * deltaSeconds;
			this.highMesh.rotation.y += (DYNAMIC_HIGH_ROTATION_SPEED_Y_DEG_PER_SEC * Math.PI / 180) * deltaSeconds;
			if (this.highShader) {
				this.highShader.uniforms.uTime.value = nowSec;
			}
		}
	}

	destroy() {
		if (this.nightMaskTexture) {
			this.nightMaskTexture.dispose();
			this.nightMaskTexture = null;
		}
		if (this.highMesh) {
			this.highMesh.geometry.dispose();
			if (this.highMesh.material.map) {
				this.highMesh.material.map.dispose();
			}
			this.highMesh.material.dispose();
			if (this.highMesh.parent) {
				this.highMesh.parent.remove(this.highMesh);
			}
			this.highMesh = null;
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
		this.highShader = null;
	}
}
window.CloudsLayer = CloudsLayer;
