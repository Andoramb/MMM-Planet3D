/* global EarthCompositor, Log */

/*
 * Earth3DRenderer
 * Owns the three-globe/Three.js scene for MMM-Earth3D. Kept separate from
 * the MagicMirror module file so future features (clouds, day/night,
 * markers, live data overlays) grow here without touching MM lifecycle code.
 *
 * Three.js itself, three-globe, and OrbitControls are all real ES modules,
 * loaded via dynamic import() (see loadThreeGlobeDeps() below) rather than
 * MM's getScripts() - this file stays a classic script for the same reason
 * CloudsLayer.mjs's own header already documents (MM core's script loader
 * only recognizes a fixed extension set that varies by core version, with no
 * default/fallback case, so an unrecognized extension can silently no-op on
 * some versions). All three modules resolve "./vendor/three.module.min.js"
 * by relative path (see public/vendor/three-globe.mjs and OrbitControls.js),
 * so they - and CloudsLayer.mjs, which imports the same file - share a
 * single Three.js instance, no globals involved.
 */

// rotationSpeed config (0-100) maps onto degrees/second of manual spin.
const ROTATION_SPEED_MAX_DEG_PER_SEC = 10; // 100 -> full revolution every 36s

// camera.zoom config (0-100) maps onto camera distance, in globe radii.
const ZOOM_ALTITUDE_MIN = 0.5; // 100 -> close
const ZOOM_ALTITUDE_MAX = 5; // 0   -> far

// Live config changes ease in over this long instead of jumping.
const TRANSITION_MS = 700;

// How often to check whether another opaque layer (e.g. a sibling
// fullscreen_below module stacked on top in the DOM) is fully covering the
// globe. A plain interval instead of a per-frame check since this only needs
// to catch layout/stacking changes, not animate anything.
const OCCLUSION_CHECK_MS = 1000;

// quality presets: sphere tessellation (lower curvatureResolution = more
// polygons = smoother), antialiasing (renderer construction option, can't
// change after init), a device-pixel-ratio cap, and which resolution key
// to request from the active texture preset's `images` map.
const QUALITY_PRESETS = {
	low: { curvatureResolution: 10, antialias: false, maxPixelRatio: 1, textureRes: "2k" },
	medium: { curvatureResolution: 6, antialias: true, maxPixelRatio: 1, textureRes: "2k" },
	high: { curvatureResolution: 3, antialias: true, maxPixelRatio: 2, textureRes: "4k" },
	ultra: { curvatureResolution: 1, antialias: true, maxPixelRatio: 3, textureRes: "8k" }
};

// Camera: fov matches what this module has always rendered with (both
// three-globe and the library it used to sit on top of just use
// THREE.PerspectiveCamera's own default of 50) - kept as an explicit named
// constant here instead of an inherited default. near/far and the controls'
// distance clamp below are sized to what this module actually renders (the
// camera's distance from the globe never exceeds globeRadius * (1 +
// ZOOM_ALTITUDE_MAX), i.e. globeRadius * 6) rather than copied from a
// far plane sized for a 50,000-unit sky sphere this module doesn't use.
const CAMERA_FOV = 50;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR_MULTIPLIER = 50; // far = globeRadius * this

// enableZoom is always false (see createControls()), so these bounds are
// inert in practice - the config-driven zoom tween (see applyZoom()/tick())
// never approaches either one. Set anyway for parity/explicitness rather
// than left unset.
const CONTROLS_MIN_DISTANCE = 0.1;
const CONTROLS_MAX_DISTANCE_MULTIPLIER = 50; // maxDistance = globeRadius * this

// Matches the look this module has always rendered with (previously hidden
// inside the render library's own defaults) - now first-class, locally
// tunable constants instead of inherited behavior.
const AMBIENT_LIGHT_COLOR = 0xcccccc;
const AMBIENT_LIGHT_INTENSITY = Math.PI;
const KEY_LIGHT_COLOR = 0xffffff;
const KEY_LIGHT_INTENSITY = 0.6 * Math.PI;

// Loads three-globe + OrbitControls, both real ES modules statically
// importing this project's own vendored Three.js by relative path (see
// public/vendor/three-globe.mjs's generating script and OrbitControls.js's
// header comment) - so this, CloudsLayer.mjs, and three-globe.mjs itself all
// end up sharing the exact same Three.js instance, with no window globals
// involved anywhere in the chain.
async function loadThreeGlobeDeps() {
	const [THREE, threeGlobeModule, orbitControlsModule] = await Promise.all([
		import("./vendor/three.module.min.js"),
		import("./vendor/three-globe.mjs"),
		import("./vendor/OrbitControls.js")
	]);
	return { THREE, ThreeGlobe: threeGlobeModule.default, OrbitControls: orbitControlsModule.OrbitControls };
}

// Eases a single number from its current value to a target over a fixed
// duration. Used for every live-tunable property so changes glide in
// smoothly instead of jumping.
class TweenedValue {
	constructor(initial) {
		this.current = initial;
		this.from = initial;
		this.to = initial;
		this.startTime = 0;
		this.duration = 0;
	}

	setTarget(value, durationMs) {
		if (value === this.to) {
			return;
		}
		this.from = this.current;
		this.to = value;
		this.startTime = performance.now();
		this.duration = durationMs;
	}

	update(now) {
		if (this.duration <= 0) {
			this.current = this.to;
			return;
		}
		const t = Math.min((now - this.startTime) / this.duration, 1);
		this.current = this.from + (this.to - this.from) * easeInOutCubic(t);
		if (t >= 1) {
			this.duration = 0;
		}
	}
}

class Earth3DRenderer {
	constructor(container, config) {
		this.container = container;
		this.config = config;

		this.THREE = null;
		this.ThreeGlobeCtor = null;
		this.OrbitControlsCtor = null;

		this.renderer = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.threeGlobeObj = null;

		this.compositor = null;
		this.cloudsLayer = null;
		this.destroyed = false;
		this.animating = false;
		this.serverTimeOffsetMs = 0;
		this.pendingCloudsNightMask = null;

		const { rotate, position } = config.camera;
		this.tiltX = new TweenedValue(rotate.x);
		this.tiltY = new TweenedValue(rotate.y);
		this.tiltZ = new TweenedValue(rotate.z);
		this.posX = new TweenedValue(position.x);
		this.posY = new TweenedValue(position.y);
		this.posZ = new TweenedValue(position.z);
		this.zoomAltitude = new TweenedValue(this.zoomToAltitude(config.camera.zoom));
		this.spinRate = new TweenedValue(rotationSpeedToDegPerSec(config.rotationSpeed));
		this.spinAngle = 0;
		this.lastFrameTime = null;

		this.init();

		// container.style.width/height may be a fixed px value or "100vw"/"100vh"
		// (fullscreen_* positions) - either way the renderer needs concrete
		// pixel dimensions, so track the container's actual rendered size
		// instead of trusting config.width/height, and keep it in sync as the
		// screen/window resizes.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);

		// Several MM setups stack more than one fullscreen_below module (e.g.
		// a background slideshow/wallpaper module alongside this one) with no
		// explicit z-index, so whichever loads last simply paints over the
		// others. When that happens the globe is still fully rendering every
		// frame for nothing - checkOcclusion() below sets this.occluded, and
		// tick() simply skips the draw call while covered.
		this.occluded = false;
		this.occlusionInterval = setInterval(() => this.checkOcclusion(), OCCLUSION_CHECK_MS);
	}

	// Hit-tests the container's center point. This only catches occlusion by
	// an element with default pointer-events (like an <img>/<video> background
	// layer) - a sibling that sets pointer-events:none on its covering
	// element would still visually hide the globe but pass this check, since
	// elementFromPoint skips non-hit-testable elements. Good enough for the
	// common "another fullscreen_below module paints over this one" case.
	checkOcclusion() {
		if (this.destroyed || !this.renderer) {
			return;
		}
		const rect = this.container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			return;
		}
		const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
		const occluded = !topElement || !this.container.contains(topElement);
		this.occluded = occluded;
	}

	// Falls back to config.width/height (then 500) only for the brief window
	// before the container has been laid out at all - once attached, the
	// measured size always wins.
	getContainerSize() {
		const rect = this.container.getBoundingClientRect();
		return {
			width: Math.round(rect.width) || this.config.width || 500,
			height: Math.round(rect.height) || this.config.height || 500
		};
	}

	handleResize() {
		if (!this.renderer || !this.camera) {
			return;
		}
		const size = this.getContainerSize();
		this.renderer.setSize(size.width, size.height, false);
		this.camera.aspect = size.width / size.height;
		this.camera.updateProjectionMatrix();
	}

	async init() {
		const quality = QUALITY_PRESETS[this.config.quality] || QUALITY_PRESETS.high;
		const textures = this.resolveTextureUrls();
		const size = this.getContainerSize();

		// Only loaded once - on a quality-triggered rebuild (see
		// applyQuality()) these are already cached, so the rest of this
		// method runs synchronously with no import to wait on.
		if (!this.ThreeGlobeCtor) {
			try {
				const deps = await loadThreeGlobeDeps();
				this.THREE = deps.THREE;
				this.ThreeGlobeCtor = deps.ThreeGlobe;
				this.OrbitControlsCtor = deps.OrbitControls;
			} catch (err) {
				Log.error("MMM-Earth3D: failed to load three-globe/OrbitControls (" + err.message + ") - globe will not render");
				return;
			}
			if (this.destroyed) {
				return;
			}
		}

		this.createRenderer(quality, size);
		this.createScene();
		this.createGlobe(textures, quality);
		this.createCamera(size);
		this.createLights();
		this.createControls();

		this.applyAtmosphere();
		this.applyZoom();

		this.ensureCloudsLayer();

		if (!this.compositor) {
			this.compositor = new EarthCompositor(
				this.config,
				(dataUrl) => {
					this.debugLog("compositor onReady: applying globeImageUrl, length", dataUrl.length, "threeGlobeObj ready:", Boolean(this.threeGlobeObj));
					if (this.threeGlobeObj) {
						this.threeGlobeObj.globeImageUrl(dataUrl);
					}
				},
				(image) => {
					this.debugLog("compositor onCloudsImage", image.naturalWidth + "x" + image.naturalHeight, "cloudsLayer ready:", Boolean(this.cloudsLayer));
					this.pendingCloudsImage = image;
					if (this.cloudsLayer) {
						this.applyCloudsImage(image);
					}
				},
				(maskImage) => {
					this.debugLog("compositor onCloudsNightMask", Boolean(maskImage), "cloudsLayer ready:", Boolean(this.cloudsLayer));
					this.pendingCloudsNightMask = maskImage;
					if (this.cloudsLayer) {
						this.cloudsLayer.setNightMask(maskImage);
					}
				},
				(path) => this.assetPath(path)
			);
		}
		this.compositor.start(textures.image);

		this.startRenderLoop();
	}

	createRenderer(quality, size) {
		this.renderer = new this.THREE.WebGLRenderer({ antialias: quality.antialias, alpha: true });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(quality.maxPixelRatio, window.devicePixelRatio));
		this.renderer.setSize(size.width, size.height, false);
		this.container.appendChild(this.renderer.domElement);
	}

	createScene() {
		this.scene = new this.THREE.Scene();
	}

	// bumpImageUrl/globeCurvatureResolution are three-globe's own config
	// methods; the composited day/night color map is set later by the
	// compositor's onReady callback (see init() above), once it has finished
	// layering day/night.
	createGlobe(textures, quality) {
		this.threeGlobeObj = new this.ThreeGlobeCtor()
			.bumpImageUrl(textures.bump)
			.globeCurvatureResolution(quality.curvatureResolution);
		this.scene.add(this.threeGlobeObj);
	}

	// Created after createGlobe() so the far plane can be sized against the
	// globe's real radius (see CAMERA_FAR_MULTIPLIER above) instead of a
	// guessed constant. Initial position is an arbitrary unit vector along
	// +Z - applyZoom(), called right after createControls() below, scales it
	// to the actual configured distance before the first frame ever renders.
	createCamera(size) {
		const globeRadius = this.threeGlobeObj.getGlobeRadius();
		this.camera = new this.THREE.PerspectiveCamera(CAMERA_FOV, size.width / size.height, CAMERA_NEAR, globeRadius * CAMERA_FAR_MULTIPLIER);
		this.camera.position.set(0, 0, 1);
	}

	createLights() {
		this.scene.add(
			new this.THREE.AmbientLight(AMBIENT_LIGHT_COLOR, AMBIENT_LIGHT_INTENSITY),
			new this.THREE.DirectionalLight(KEY_LIGHT_COLOR, KEY_LIGHT_INTENSITY)
		);
	}

	createControls() {
		this.controls = new this.OrbitControlsCtor(this.camera, this.renderer.domElement);
		// Spin is applied manually each frame (see tick()) around the globe's
		// own local axis, so it correctly follows any fixed tilt. OrbitControls'
		// built-in autoRotate always orbits the camera around the world's
		// vertical axis instead, which looks wrong once the globe is tilted.
		this.controls.autoRotate = false;
		this.controls.enableZoom = false;
		this.controls.minDistance = CONTROLS_MIN_DISTANCE;
		this.controls.maxDistance = this.threeGlobeObj.getGlobeRadius() * CONTROLS_MAX_DISTANCE_MULTIPLIER;
	}

	startRenderLoop() {
		if (this.animating) {
			return;
		}
		this.animating = true;
		requestAnimationFrame((now) => this.tick(now));
	}

	// Live-update entry points: config is shared by reference with the
	// MMM-Earth3D module instance, so callers mutate this.config first and
	// then call the matching apply*() to ease the live scene toward it.

	debugLog() {
		if (!this.config || !this.config.debug) {
			return;
		}
		Log.info.apply(Log, ["[MMM-Earth3D:Earth3DRenderer]"].concat(Array.prototype.slice.call(arguments)));
	}

	applyRotationSpeed() {
		this.debugLog("applyRotationSpeed", this.config.rotationSpeed);
		this.spinRate.setTarget(rotationSpeedToDegPerSec(this.config.rotationSpeed), TRANSITION_MS);
	}

	applyZoom() {
		this.debugLog("applyZoom", this.config.camera.zoom);
		this.zoomAltitude.setTarget(this.zoomToAltitude(this.config.camera.zoom), TRANSITION_MS);
	}

	applyGlobeTransform() {
		const { rotate, position } = this.config.camera;
		this.debugLog("applyGlobeTransform", { rotate, position });
		this.tiltX.setTarget(rotate.x, TRANSITION_MS);
		this.tiltY.setTarget(rotate.y, TRANSITION_MS);
		this.tiltZ.setTarget(rotate.z, TRANSITION_MS);
		this.posX.setTarget(position.x, TRANSITION_MS);
		this.posY.setTarget(position.y, TRANSITION_MS);
		this.posZ.setTarget(position.z, TRANSITION_MS);
	}

	// Antialiasing is a WebGLRenderer construction option and can't be
	// changed on an existing context, so quality changes rebuild the scene.
	// Tween/spin state is left untouched so tilt/position/rotation continue
	// smoothly across the rebuild. This also re-picks the texture resolution
	// key (2k/4k/8k) matching the new quality tier.
	applyQuality() {
		this.debugLog("applyQuality", this.config.quality);
		// Destroy cloudsLayer BEFORE the globe: its meshes sit alongside the
		// globe object and disposeObject3D()/teardownScene() below walks the
		// scene - detaching and disposing clouds here first avoids a
		// double-dispose and means we don't try to reuse now-invalid GPU
		// resources afterwards. init() builds a fresh cloudsLayer and
		// re-fetches the clouds image via the compositor.
		if (this.cloudsLayer) {
			this.cloudsLayer.destroy();
			this.cloudsLayer = null;
		}
		this.teardownScene();
		this.init();
	}

	// showAtmosphere/atmosphereColor/atmosphereAltitude are regular
	// chainable three-globe props, so this applies live with no rebuild.
	// opacity isn't a native three-globe concept - approximated here as a
	// visibility threshold until/unless real alpha blending is added.
	applyAtmosphere() {
		const { color, altitude, opacity } = this.config.atmosphere;
		const visible = opacity > 0;
		this.debugLog("applyAtmosphere", { color, altitude, opacity, visible });
		if (!this.threeGlobeObj) {
			return;
		}
		this.threeGlobeObj.showAtmosphere(visible);
		if (visible) {
			this.threeGlobeObj.atmosphereColor(color).atmosphereAltitude(altitude);
		}
	}

	// bumpImageUrl is a regular chainable prop, so it applies live. The
	// color map goes through the compositor instead of globeImageUrl
	// directly, since the night layer blends on top of it.
	applyTexture() {
		const textures = this.resolveTextureUrls();
		this.debugLog("applyTexture", textures);
		if (this.threeGlobeObj && textures.bump) {
			this.threeGlobeObj.bumpImageUrl(textures.bump);
		}
		if (this.compositor) {
			this.compositor.setDayImage(textures.image);
		}
	}

	// Live-update entry points for the day/night and clouds layers.
	applyDayNight() {
		this.debugLog("applyDayNight", this.config.dayNight);
		if (this.compositor) {
			this.compositor.scheduleDayNight();
			this.compositor.recompute();
		}
	}

	applyClouds() {
		this.debugLog("applyClouds", this.config.clouds, "cloudsLayer ready:", Boolean(this.cloudsLayer));
		if (this.cloudsLayer) {
			this.cloudsLayer.setOpacity(this.config.clouds.opacity);
			this.cloudsLayer.setVisible(this.config.clouds.enabled);
		}
		if (this.compositor) {
			this.compositor.applyCloudsConfig();
		}
	}

	// Called once MMM-Earth3D.js hears back from node_helper with the actual
	// MagicMirror host's clock (see its EARTH3D_SERVER_TIME handler) - kept
	// here too (not just forwarded straight to the compositor) since the
	// compositor might not exist yet if this arrives before DOM_OBJECTS_CREATED.
	setServerTimeOffset(offsetMs) {
		this.debugLog("setServerTimeOffset", offsetMs);
		this.serverTimeOffsetMs = offsetMs;
		if (this.compositor) {
			this.compositor.setServerTimeOffset(offsetMs);
		}
	}

	resolveTextureUrls() {
		const texture = this.config.texture;
		if (texture.preset === "custom" && texture.imageUrl) {
			return {
				image: texture.imageUrl,
				bump: texture.bumpImageUrl || null
			};
		}

		const preset = (window.EARTH3D_PRESETS.texture || []).find((entry) => entry.id === texture.preset);
		if (!preset) {
			return { image: null, bump: null };
		}

		const quality = QUALITY_PRESETS[this.config.quality] || QUALITY_PRESETS.high;
		const images = preset.texture.images;
		const image = images[quality.textureRes] || images["4k"] || Object.values(images)[0];
		const bump = preset.texture.bumpImage;

		return {
			image: image ? this.assetPath(image) : null,
			bump: bump ? this.assetPath(bump) : null
		};
	}

	zoomToAltitude(zoom) {
		const t = clamp(zoom, 0, 100) / 100;
		return ZOOM_ALTITUDE_MAX - t * (ZOOM_ALTITUDE_MAX - ZOOM_ALTITUDE_MIN);
	}

	// CloudsLayer.mjs is an ES module (it needs a real Three.js import, unlike
	// the other classic-script assets) - loaded here via a dynamic import()
	// rather than through MM's getScripts(), since MM core's own loader only
	// recognizes a fixed set of file extensions that varies by core version
	// with no default/fallback case, so an unrecognized one (older cores
	// don't have an "mjs" case at all) silently never loads the file, with
	// no error. A native dynamic import() bypasses that entirely and works
	// the same on any MM core version. Constructing this is async either
	// way, so the rest of init() (texture, resize tracking, the tick loop -
	// none of which have anything to do with clouds) doesn't wait on it.
	ensureCloudsLayer() {
		if (this.cloudsLayer || this.cloudsLayerImporting || this.destroyed) {
			return;
		}
		this.cloudsLayerImporting = true;
		// A relative specifier here resolves against this script's own file
		// URL (not the page's, and not MM's basePath config) since dynamic
		// import() in a classic script uses the referencing script's base URL
		// - CloudsLayer.mjs sits right next to this file, so "./" is enough.
		import("./CloudsLayer.mjs")
			.then((module) => {
				this.cloudsLayerImporting = false;
				if (this.destroyed || this.cloudsLayer) {
					return;
				}
				this.cloudsLayer = new module.CloudsLayer(this.threeGlobeObj.getGlobeRadius(), Boolean(this.config.debug));
				if (this.pendingCloudsImage) {
					this.applyCloudsImage(this.pendingCloudsImage);
				}
				this.cloudsLayer.setNightMask(this.pendingCloudsNightMask);
				if (this.threeGlobeObj) {
					this.cloudsLayer.attachTo(this.threeGlobeObj);
				}
			})
			.catch((err) => {
				this.cloudsLayerImporting = false;
				Log.error("MMM-Earth3D: failed to load CloudsLayer.mjs (" + err.message + ") - clouds will stay disabled");
			});
	}

	applyCloudsImage(image) {
		this.cloudsLayer.setTexture(image);
		this.cloudsLayer.setOpacity(this.config.clouds.opacity);
		this.cloudsLayer.setVisible(this.config.clouds.enabled);
		if (this.threeGlobeObj) {
			this.cloudsLayer.attachTo(this.threeGlobeObj);
		}
	}

	tick(now) {
		if (this.destroyed) {
			this.animating = false;
			return;
		}

		const deltaSeconds = this.lastFrameTime !== null ? (now - this.lastFrameTime) / 1000 : 0;
		this.lastFrameTime = now;

		this.tiltX.update(now);
		this.tiltY.update(now);
		this.tiltZ.update(now);
		this.posX.update(now);
		this.posY.update(now);
		this.posZ.update(now);
		this.spinRate.update(now);
		this.zoomAltitude.update(now);
		this.spinAngle += degToRad(this.spinRate.current) * deltaSeconds;
		if (this.cloudsLayer) {
			this.cloudsLayer.tick(now);
		}

		if (this.threeGlobeObj) {
			// Reset to the (tweened) fixed tilt, then apply the total
			// accumulated spin as a local-axis rotation on top of it, so the
			// spin always turns around the globe's own (tilted) polar axis.
			this.threeGlobeObj.rotation.set(degToRad(this.tiltX.current), degToRad(this.tiltY.current), degToRad(this.tiltZ.current));
			this.threeGlobeObj.rotateY(this.spinAngle);
			this.threeGlobeObj.position.set(this.posX.current, this.posY.current, this.posZ.current);

			// The camera and its OrbitControls target are deliberately left
			// untouched here. Earlier this followed the globe's position, but
			// OrbitControls keeps a fixed offset from its target - moving the
			// target off-axis (X/Y) forced the camera to rotate to keep facing
			// it, which is what looked like the globe "rotating" instead of
			// panning. With a static camera, moving the globe object is a
			// clean world-space translation on all three axes: X/Y pan across
			// the screen, and Z happens to align with the camera's viewing
			// direction, which is why it already looked like zoom.
		}

		if (this.camera && this.controls && this.threeGlobeObj) {
			// Preserves the camera's current bearing, only changes its
			// distance from the target - this is the one place a future
			// lat/lng orbit, alternate projection, or cinematic camera
			// transition would extend; only altitude is driven from config
			// today.
			const offset = this.camera.position.clone().sub(this.controls.target);
			offset.setLength(this.threeGlobeObj.getGlobeRadius() * (1 + this.zoomAltitude.current));
			this.camera.position.copy(this.controls.target).add(offset);
			this.controls.update();
		}

		if (this.renderer && this.scene && this.camera && !this.occluded) {
			this.renderer.render(this.scene, this.camera);
		}

		requestAnimationFrame((t) => this.tick(t));
	}

	assetPath(relativePath) {
		return "modules/MMM-Earth3D/public/" + relativePath;
	}

	// Walks an Object3D's whole subtree disposing every geometry/material
	// (and any texture referenced by a material's own properties - map,
	// bumpMap, etc, whatever the material actually has) it finds. Same
	// disposal pattern CloudsLayer.mjs already uses for its own meshes,
	// applied here to the (larger, three-globe-owned) globe/atmosphere
	// hierarchy instead of hand-listing every possible map name.
	disposeObject3D(root) {
		root.traverse((child) => {
			if (child.geometry) {
				child.geometry.dispose();
			}
			const materials = Array.isArray(child.material) ? child.material : (child.material ? [child.material] : []);
			materials.forEach((material) => {
				Object.keys(material).forEach((key) => {
					const value = material[key];
					if (value && value.isTexture) {
						value.dispose();
					}
				});
				material.dispose();
			});
		});
	}

	// Full teardown of everything created in createRenderer()/createScene()/
	// .../createControls() - used both by destroy() and by applyQuality()'s
	// rebuild. Three.js/three-globe have no single all-in-one destructor, so
	// this spells out explicitly what needs to happen: dispose the globe's
	// geometry/materials/textures, dispose the controls (drops their DOM
	// event listeners) and renderer (frees the GL context), detach the
	// canvas from the DOM, and clear every reference so nothing left running
	// (e.g. a stray already-scheduled tick()) can touch a disposed object.
	teardownScene() {
		if (this.threeGlobeObj) {
			this.disposeObject3D(this.threeGlobeObj);
			if (this.scene) {
				this.scene.remove(this.threeGlobeObj);
			}
			this.threeGlobeObj = null;
		}
		if (this.controls) {
			this.controls.dispose();
			this.controls = null;
		}
		if (this.renderer) {
			this.renderer.dispose();
			if (this.renderer.domElement && this.renderer.domElement.parentNode) {
				this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
			}
			this.renderer = null;
		}
		this.scene = null;
		this.camera = null;
	}

	destroy() {
		this.destroyed = true;
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.occlusionInterval) {
			clearInterval(this.occlusionInterval);
			this.occlusionInterval = null;
		}
		if (this.compositor) {
			this.compositor.destroy();
			this.compositor = null;
		}
		if (this.cloudsLayer) {
			this.cloudsLayer.destroy();
			this.cloudsLayer = null;
		}
		this.teardownScene();
	}
}

function rotationSpeedToDegPerSec(speed) {
	return (clamp(speed, 0, 100) / 100) * ROTATION_SPEED_MAX_DEG_PER_SEC;
}

function degToRad(deg) {
	return (deg * Math.PI) / 180;
}

function clamp(value, min, max) {
	return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
