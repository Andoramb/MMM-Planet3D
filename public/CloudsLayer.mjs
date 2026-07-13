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

// The night-shade shell (see setNightMask() below) sits fractionally
// further out than the clouds sphere - just enough to avoid z-fighting,
// invisible at this scale (globe radius = 100 units) - so it renders in
// front of (over) the clouds instead of coinciding with their surface.
const SHADE_ALTITUDE = CLOUDS_ALTITUDE + 0.0008;

export class CloudsLayer {
	constructor(globeRadius) {
		this.globeRadius = globeRadius;
		this.mesh = null;
		this.shadeMesh = null;
		this.nightMaskActive = false;
		this.lastFrameTime = null;
	}

	// Builds the mesh on first call; later calls just swap the texture
	// image (e.g. a fresh GIBS fetch) without rebuilding geometry/material.
	setTexture(image) {
		if (!this.mesh) {
			const geometry = new THREE.SphereGeometry(this.globeRadius * (1 + CLOUDS_ALTITUDE), SPHERE_SEGMENTS, SPHERE_SEGMENTS);
			const texture = new THREE.Texture(image);
			texture.needsUpdate = true;
			const material = new THREE.MeshPhongMaterial({ map: texture, transparent: true, opacity: 1 });
			this.mesh = new THREE.Mesh(geometry, material);
			return;
		}
		this.mesh.material.map.dispose();
		this.mesh.material.map = new THREE.Texture(image);
		this.mesh.material.map.needsUpdate = true;
	}

	// image is a small black/transparent alpha mask from EarthCompositor
	// (transparent on the day side, translucent black on the night side),
	// or null to hide the shading entirely (dayNight disabled).
	//
	// Deliberately its own mesh rather than baked into the clouds texture:
	// this.mesh spins independently (tick() below) for the parallax effect,
	// so anything painted into *its* texture would drift out of alignment
	// with the true terminator as it rotates. This mesh is attached directly
	// alongside it (see attachTo()) and its own rotation is never touched -
	// it only inherits the globe's overall orientation, the same as the
	// terminator baked into the globe's own (non-rotating) texture, so it
	// stays correctly aligned no matter how long the clouds have been
	// spinning or which dayNight mode (realtime/custom) is active.
	setNightMask(image) {
		this.nightMaskActive = Boolean(image);

		if (!image) {
			if (this.shadeMesh) {
				this.shadeMesh.visible = false;
			}
			return;
		}

		if (!this.shadeMesh) {
			const geometry = new THREE.SphereGeometry(this.globeRadius * (1 + SHADE_ALTITUDE), SPHERE_SEGMENTS, SPHERE_SEGMENTS);
			const texture = new THREE.Texture(image);
			texture.needsUpdate = true;
			const material = new THREE.MeshBasicMaterial({ color: 0x000000, map: texture, transparent: true, depthWrite: false });
			this.shadeMesh = new THREE.Mesh(geometry, material);
			if (this.mesh && this.mesh.parent) {
				this.mesh.parent.add(this.shadeMesh);
			}
		} else {
			this.shadeMesh.material.map.dispose();
			this.shadeMesh.material.map = new THREE.Texture(image);
			this.shadeMesh.material.map.needsUpdate = true;
		}
		this.shadeMesh.visible = this.mesh ? this.mesh.visible : true;
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
		if (this.shadeMesh) {
			this.shadeMesh.visible = visible && this.nightMaskActive;
		}
	}

	// this.shadeMesh is added as a SIBLING of this.mesh (both direct
	// children of parentObject3D), not a child of this.mesh - critical so
	// it doesn't inherit this.mesh's own independent spin from tick() below.
	attachTo(parentObject3D) {
		if (this.mesh && this.mesh.parent !== parentObject3D) {
			parentObject3D.add(this.mesh);
		}
		if (this.shadeMesh && this.shadeMesh.parent !== parentObject3D) {
			parentObject3D.add(this.shadeMesh);
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

		// Only this.mesh gets the independent parallax spin - this.shadeMesh
		// is deliberately left untouched, see setNightMask() above.
		this.mesh.rotation.x += (speedX * Math.PI / 180) * deltaSeconds;
		this.mesh.rotation.y += (speedY * Math.PI / 180) * deltaSeconds;
	}

	destroy() {
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
		if (this.shadeMesh) {
			this.shadeMesh.geometry.dispose();
			if (this.shadeMesh.material.map) {
				this.shadeMesh.material.map.dispose();
			}
			this.shadeMesh.material.dispose();
			if (this.shadeMesh.parent) {
				this.shadeMesh.parent.remove(this.shadeMesh);
			}
			this.shadeMesh = null;
		}
	}
}
window.CloudsLayer = CloudsLayer;
