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

const SPHERE_SEGMENTS = 75;

export class CloudsLayer {
	constructor(globeRadius) {
		this.globeRadius = globeRadius;
		this.mesh = null;
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
		this.mesh.rotation.x += (CLOUDS_ROTATION_SPEED_X_DEG_PER_SEC * Math.PI / 180) * deltaSeconds;
		this.mesh.rotation.y += (CLOUDS_ROTATION_SPEED_Y_DEG_PER_SEC * Math.PI / 180) * deltaSeconds;
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
	}
}
window.CloudsLayer = CloudsLayer;
