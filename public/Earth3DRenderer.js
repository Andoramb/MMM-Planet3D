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

// rotationSpeed config (0-100, though only 0-25 is actually reachable - see
// ROTATION_SPEED_SATURATION) maps onto degrees/second of manual spin.
const ROTATION_SPEED_MAX_DEG_PER_SEC = 10; // 100 -> full revolution every 36s, if it were reachable

// The full 0-100 config range felt too fast well before reaching 100 - most
// of that range was unusable in practice. Rather than rescale the whole
// curve (which would also make the already-comfortable low end steeper/
// faster for the same value), the input is simply clamped here: 25 and
// above all produce the same speed 25 always did (2.5 deg/sec, one
// revolution every 144s), and 0-25 feels exactly as before.
const ROTATION_SPEED_SATURATION = 25;

// camera.zoom config (0-100) maps onto camera distance, in globe radii.
const ZOOM_ALTITUDE_MIN = 0.5; // 100 -> close
const ZOOM_ALTITUDE_MAX = 5; // 0   -> far

// Live config changes ease in over this long instead of jumping.
const TRANSITION_MS = 700;

// centerOnCity()'s one-shot spin animation - longer than TRANSITION_MS since
// it can cover up to a half-turn of the globe and reads better as a
// deliberate "rotating into position" motion than a snap.
const CENTER_ON_CITY_TRANSITION_MS = 2000;

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

// The background is a giant textured sphere viewed from inside, attached as
// a child of the globe's own rotating group (see createGlobe()/tick()) so it
// spins in lockstep with the surface instead of staying fixed like a real
// night sky would - a deliberate stylistic choice for this module, not a
// literal skybox. Radius is a multiple of the globe's own radius (globe
// radius = 100 scene units): must stay comfortably inside the camera's far
// plane (globeRadius * CAMERA_FAR_MULTIPLIER below) and well outside the
// camera's maximum orbit distance (globeRadius * (1 + ZOOM_ALTITUDE_MAX) = 6x)
// so the camera never pokes through it.
const BACKGROUND_SPHERE_RADIUS_MULTIPLIER = 30;
const BACKGROUND_SPHERE_SEGMENTS = 32; // viewed from deep inside a huge radius - no need for globe-grade tessellation

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

// Loads three-globe + OrbitControls + CSS2DRenderer, all real ES modules
// statically importing this project's own vendored Three.js by relative path
// (see public/vendor/three-globe.mjs's generating script and
// OrbitControls.js's header comment) - so this, CloudsLayer.mjs, and
// three-globe.mjs itself all end up sharing the exact same Three.js instance,
// with no window globals involved anywhere in the chain. CSS2DRenderer is
// what actually mounts three-globe's htmlElementsData markers (the city
// label - see applyCity()) into the DOM; three-globe's own vendored bundle
// only creates the CSS2DObject scene nodes, it doesn't render them anywhere.
async function loadThreeGlobeDeps() {
	const [THREE, threeGlobeModule, orbitControlsModule, css2DModule] = await Promise.all([
		import("./vendor/three.module.min.js"),
		import("./vendor/three-globe.mjs"),
		import("./vendor/OrbitControls.js"),
		import("./vendor/CSS2DRenderer.js")
	]);
	return {
		THREE,
		ThreeGlobe: threeGlobeModule.default,
		OrbitControls: orbitControlsModule.OrbitControls,
		CSS2DRenderer: css2DModule.CSS2DRenderer
	};
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
	constructor(container, config, cacheBust) {
		this.container = container;
		this.config = config;
		// Only applied to CloudsLayer.mjs's own import (see ensureCloudsLayer()) -
		// deliberately NOT applied to three.module.min.js/three-globe.mjs/
		// OrbitControls.js in loadThreeGlobeDeps() below, since those three
		// cross-reference each other via fixed relative specifiers with no
		// query string; cache-busting only one of those outer import() calls
		// would make it resolve to a DIFFERENT module instance than what the
		// others still see internally, fragmenting the single-shared-THREE
		// guarantee this migration was largely about. Those three rarely
		// change (only on a deliberate re-vendor), unlike CloudsLayer.mjs.
		this.cacheBust = cacheBust ? ("?v=" + cacheBust) : "";

		this.THREE = null;
		this.ThreeGlobeCtor = null;
		this.OrbitControlsCtor = null;
		this.CSS2DRendererCtor = null;

		this.renderer = null;
		this.cssRenderer = null;
		this.scene = null;
		this.camera = null;
		this.controls = null;
		this.threeGlobeObj = null;

		this.compositor = null;
		this.cloudsLayer = null;
		this.flightLayer = null;
		this.flightLayerImporting = false;
		this.starfieldLayer = null;
		this.starfieldLayerImporting = false;
		this.backgroundMesh = null;
		this.backgroundLoadId = 0;
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
		// 0 = normal spin/tilt (flights.track off), 1 = fully blended toward
		// facing the tracked flight (see applyFlights()/tick()).
		this.flightTrackBlend = new TweenedValue(0);
		// Set by centerOnCity() - a one-shot override that drives spinAngle to
		// a computed target over CENTER_ON_CITY_TRANSITION_MS, pausing the
		// normal spinRate accumulation until it arrives (see tick()), then
		// clears itself so normal spin resumes from wherever it landed.
		this.spinOverrideTween = null;
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
		if (this.cssRenderer) {
			this.cssRenderer.setSize(size.width, size.height);
		}
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
				this.CSS2DRendererCtor = deps.CSS2DRenderer;
			} catch (err) {
				Log.error("MMM-Earth3D: failed to load three-globe/OrbitControls (" + err.message + ") - globe will not render");
				return;
			}
			if (this.destroyed) {
				return;
			}
		}

		this.createRenderer(quality, size);
		this.createCssRenderer(size);
		this.createScene();
		this.createGlobe(textures, quality);
		this.createCamera(size);
		this.createLights();
		this.createControls();

		this.applyAtmosphere();
		this.applyZoom();
		this.applyBackground();
		this.applyCity();

		this.ensureCloudsLayer();
		this.ensureFlightLayer();
		this.ensureStarfieldLayer();

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

	// Overlays the WebGL canvas with a same-sized DOM layer that three-globe's
	// htmlElementsData markers (the city label - see applyCity()) get mounted
	// into each frame (see tick()). Positioned absolute over the canvas -
	// css/MMM-Earth3D.css puts `position: relative` on the container so that's
	// relative to the globe, not the page. pointer-events: none so it never
	// blocks the occlusion check in checkOcclusion() or (on setups that enable
	// it) OrbitControls' own mouse/touch handling on the canvas beneath it.
	createCssRenderer(size) {
		this.cssRenderer = new this.CSS2DRendererCtor();
		this.cssRenderer.setSize(size.width, size.height);
		this.cssRenderer.domElement.style.position = "absolute";
		this.cssRenderer.domElement.style.top = "0";
		this.cssRenderer.domElement.style.left = "0";
		this.cssRenderer.domElement.style.pointerEvents = "none";
		this.container.appendChild(this.cssRenderer.domElement);
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
		if (this.flightLayer) {
			this.flightLayer.destroy();
			this.flightLayer = null;
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

	// Toggles/swaps the background (see BACKGROUND_SPHERE_RADIUS_MULTIPLIER
	// above for why the image sphere is attached to threeGlobeObj rather than
	// the scene directly - the "star-particles" preset's StarfieldLayer is
	// attached the same way, see ensureStarfieldLayer()). Disabling just hides
	// whichever is currently built rather than disposing it, so re-enabling
	// the same preset is instant - no re-fetch/re-decode/re-randomize. Exactly
	// one of the image mesh or the particle layer is ever visible.
	applyBackground() {
		const selection = this.resolveBackgroundSelection();
		this.debugLog("applyBackground", selection);
		if (!selection) {
			if (this.backgroundMesh) {
				this.backgroundMesh.visible = false;
			}
			if (this.starfieldLayer) {
				this.starfieldLayer.setVisible(false);
			}
			return;
		}
		if (selection.type === "starfield") {
			if (this.backgroundMesh) {
				this.backgroundMesh.visible = false;
			}
			if (this.starfieldLayer) {
				this.starfieldLayer.setVisible(true);
			}
			return;
		}
		if (this.starfieldLayer) {
			this.starfieldLayer.setVisible(false);
		}
		if (this.backgroundMesh && this.backgroundMesh.userData.url === selection.url) {
			this.backgroundMesh.visible = true;
			return;
		}
		this.loadBackgroundTexture(selection.url);
	}

	// Returns null (background off/unresolved), { type: "starfield" }, or { type: "image", url }.
	resolveBackgroundSelection() {
		const background = this.config.background;
		if (!background || !background.enabled) {
			return null;
		}
		if (background.preset === "custom") {
			return background.imageUrl ? { type: "image", url: background.imageUrl } : null;
		}
		const preset = (window.EARTH3D_PRESETS.background || []).find((entry) => entry.id === background.preset);
		if (!preset) {
			return null;
		}
		if (preset.background.starfield) {
			return { type: "starfield" };
		}
		if (!preset.background.imageUrl) {
			return null;
		}
		return { type: "image", url: this.assetPath(preset.background.imageUrl) };
	}

	// requestId guards against a slow-loading earlier request (e.g. switching
	// preset twice quickly) clobbering a newer one that already finished -
	// the same instinct as ignoring a stale network response anywhere else.
	loadBackgroundTexture(url) {
		if (!this.threeGlobeObj || !this.THREE) {
			return;
		}
		const requestId = ++this.backgroundLoadId;
		new this.THREE.TextureLoader().load(url, (texture) => {
			if (this.destroyed || requestId !== this.backgroundLoadId) {
				texture.dispose();
				return;
			}
			texture.colorSpace = this.THREE.SRGBColorSpace;
			if (!this.backgroundMesh) {
				const radius = this.threeGlobeObj.getGlobeRadius() * BACKGROUND_SPHERE_RADIUS_MULTIPLIER;
				const geometry = new this.THREE.SphereGeometry(radius, BACKGROUND_SPHERE_SEGMENTS, BACKGROUND_SPHERE_SEGMENTS);
				// Mirrored (not BackSide) so the inside view isn't texture-flipped -
				// BackSide alone renders correctly but reverses apparent rotation vs the globe.
				geometry.scale(-1, 1, 1);
				const material = new this.THREE.MeshBasicMaterial({ map: texture });
				this.backgroundMesh = new this.THREE.Mesh(geometry, material);
				this.threeGlobeObj.add(this.backgroundMesh);
			} else {
				if (this.backgroundMesh.material.map) {
					this.backgroundMesh.material.map.dispose();
				}
				this.backgroundMesh.material.map = texture;
			}
			this.backgroundMesh.userData.url = url;
			this.backgroundMesh.visible = true;
		});
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

	// flights.enabled/pollInterval drive the marker/interpolation timing;
	// flights.track drives how far tick()'s rotation blends toward facing
	// the tracked flight - both ease in via the same TweenedValue/
	// TRANSITION_MS convention as every other live-tunable field.
	applyFlights() {
		const flights = this.config.flights;
		this.debugLog("applyFlights", flights, "flightLayer ready:", Boolean(this.flightLayer));
		if (this.flightLayer) {
			this.flightLayer.setVisible(flights.enabled);
			this.flightLayer.setPollIntervalMs(flights.pollInterval * 1000);
		}
		this.flightTrackBlend.setTarget(flights.enabled && flights.track ? 1 : 0, TRANSITION_MS);
	}

	// Live telemetry pushed from node_helper's OpenSky poller
	// (EARTH3D_FLIGHT_POSITION) - not a config field, so this is called
	// directly from MMM-Earth3D.js's socketNotificationReceived rather than
	// going through an apply*()-from-config path.
	updateFlightPosition(data) {
		this.debugLog("updateFlightPosition", data, "flightLayer ready:", Boolean(this.flightLayer));
		if (this.flightLayer) {
			this.flightLayer.pushSample(data);
		}
	}

	// city.lat/lng are already resolved (name -> coordinates, via
	// presets/cities.js) by MMM-Earth3D.js's resolveCity() before this is
	// called - this class never looks the name up itself. A single
	// htmlElementsData entry rather than three-globe's own pointsData/
	// labelsData layers so the whole marker (dot + label) is one real DOM
	// element, styleable from css/MMM-Earth3D.css (.earth3d-city-marker/
	// -dot/-label) instead of baked-in 3D text geometry.
	applyCity() {
		if (!this.threeGlobeObj) {
			return;
		}
		const city = this.config.city;
		this.debugLog("applyCity", city);
		if (!city || city.lat === null || city.lng === null) {
			this.threeGlobeObj.htmlElementsData([]);
			return;
		}
		this.threeGlobeObj
			.htmlElementsData([city])
			.htmlLat("lat")
			.htmlLng("lng")
			.htmlAltitude(0.01)
			.htmlElement(() => this.createCityMarkerElement(city));
	}

	createCityMarkerElement(city) {
		const el = document.createElement("div");
		el.className = "earth3d-city-marker";
		const dot = document.createElement("span");
		dot.className = "earth3d-city-dot";
		const label = document.createElement("span");
		label.className = "earth3d-city-label";
		label.textContent = city.matchedName || city.name;
		el.append(dot, label);
		return el;
	}

	// Eases the globe's spin so the given lat/lng ends up facing the camera,
	// without stopping or resetting the normal auto-rotation - it resumes
	// from wherever this lands (see the spinOverrideTween handling in tick()).
	//
	// Only spinAngle (rotation around the globe's own local Y axis, applied
	// before the fixed camera.rotate tilt - see tick()'s
	// threeGlobeObj.rotation.set()+rotateY() pair) is adjustable here; tilt
	// itself is left alone. Conjugating by the tilt quaternion turns that
	// into "rotate around a FIXED world-space axis" (the tilted polar axis),
	// which is what makes solving for the needed angle tractable: project the
	// city's tilted-but-unspun position and the camera direction onto the
	// plane perpendicular to that axis, and the signed angle between those
	// two projections is exactly the spin needed to bring them into
	// alignment. If the city sits on (or very near) that axis - e.g. a pole
	// under a heavily tilted globe - its azimuth is undefined and there's
	// nothing meaningful to solve for, so this just leaves spin alone.
	centerOnCity(lat, lng) {
		if (!this.threeGlobeObj || !this.camera || !this.THREE || typeof lat !== "number" || typeof lng !== "number") {
			return;
		}
		const THREE = this.THREE;
		const { rotate } = this.config.camera;
		const tiltQuat = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(degToRad(rotate.x), degToRad(rotate.y), degToRad(rotate.z), "XYZ")
		);
		const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(tiltQuat);

		const coords = this.threeGlobeObj.getCoords(lat, lng, 0);
		const tiltedCity = new THREE.Vector3(coords.x, coords.y, coords.z).applyQuaternion(tiltQuat);
		const toCamera = this.camera.position.clone().sub(this.threeGlobeObj.position).normalize();

		const projectOnPlane = (v) => v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
		const cityPerp = projectOnPlane(tiltedCity);
		const cameraPerp = projectOnPlane(toCamera);
		if (cityPerp.lengthSq() < 1e-6 || cameraPerp.lengthSq() < 1e-6) {
			this.debugLog("centerOnCity: azimuth undefined (city on tilt axis) - leaving spin alone", { lat, lng });
			return;
		}

		const targetAngle = Math.atan2(
			new THREE.Vector3().crossVectors(cityPerp, cameraPerp).dot(axis),
			cityPerp.dot(cameraPerp)
		);

		// targetAngle is the ABSOLUTE spin (from zero) that centers the city -
		// spinAngle itself accumulates without wrapping, so pick whichever
		// full-turn offset of targetAngle is nearest to the current
		// spinAngle, for the shortest visible rotation either direction.
		const twoPi = Math.PI * 2;
		const target = targetAngle + Math.round((this.spinAngle - targetAngle) / twoPi) * twoPi;
		this.debugLog("centerOnCity", { lat, lng, from: this.spinAngle, to: target });
		this.spinOverrideTween = { from: this.spinAngle, to: target, startTime: performance.now(), duration: CENTER_ON_CITY_TRANSITION_MS };
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
		import("./CloudsLayer.mjs" + this.cacheBust)
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

	// FlightLayer.mjs is loaded the same way and for the same reason as
	// CloudsLayer.mjs above (a dynamic import(), bypassing MM's getScripts()
	// extension-sniffing).
	ensureFlightLayer() {
		if (this.flightLayer || this.flightLayerImporting || this.destroyed) {
			return;
		}
		this.flightLayerImporting = true;
		import("./FlightLayer.mjs" + this.cacheBust)
			.then((module) => {
				this.flightLayerImporting = false;
				if (this.destroyed || this.flightLayer) {
					return;
				}
				this.flightLayer = new module.FlightLayer(this.threeGlobeObj.getGlobeRadius(), Boolean(this.config.debug));
				if (this.threeGlobeObj) {
					this.flightLayer.attachTo(this.threeGlobeObj);
				}
				this.applyFlights();
			})
			.catch((err) => {
				this.flightLayerImporting = false;
				Log.error("MMM-Earth3D: failed to load FlightLayer.mjs (" + err.message + ") - flight tracking will stay disabled");
			});
	}

	// StarfieldLayer.mjs is loaded the same way and for the same reason as
	// CloudsLayer.mjs above. Built unconditionally regardless of the current
	// background preset (like clouds/flights above) so switching to the
	// "star-particles" preset later is instant - applyBackground() drives its
	// visibility once it exists.
	ensureStarfieldLayer() {
		if (this.starfieldLayer || this.starfieldLayerImporting || this.destroyed) {
			return;
		}
		this.starfieldLayerImporting = true;
		import("./StarfieldLayer.mjs" + this.cacheBust)
			.then((module) => {
				this.starfieldLayerImporting = false;
				if (this.destroyed || this.starfieldLayer) {
					return;
				}
				this.starfieldLayer = new module.StarfieldLayer(this.threeGlobeObj.getGlobeRadius(), Boolean(this.config.debug));
				if (this.threeGlobeObj) {
					this.starfieldLayer.attachTo(this.threeGlobeObj);
				}
				const selection = this.resolveBackgroundSelection();
				this.starfieldLayer.setVisible(Boolean(selection && selection.type === "starfield"));
			})
			.catch((err) => {
				this.starfieldLayerImporting = false;
				Log.error("MMM-Earth3D: failed to load StarfieldLayer.mjs (" + err.message + ") - star particles will stay disabled");
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
		this.flightTrackBlend.update(now);
		if (this.spinOverrideTween) {
			const t = Math.min((now - this.spinOverrideTween.startTime) / this.spinOverrideTween.duration, 1);
			this.spinAngle = this.spinOverrideTween.from + (this.spinOverrideTween.to - this.spinOverrideTween.from) * easeInOutCubic(t);
			if (t >= 1) {
				this.spinOverrideTween = null;
			}
		} else {
			this.spinAngle += degToRad(this.spinRate.current) * deltaSeconds;
		}
		if (this.cloudsLayer) {
			this.cloudsLayer.tick(now);
		}
		if (this.flightLayer) {
			this.flightLayer.tick(now);
		}
		if (this.starfieldLayer) {
			this.starfieldLayer.tick(now);
		}

		if (this.threeGlobeObj) {
			// Base orientation: the (tweened) fixed tilt, with the total
			// accumulated spin applied as a local-axis rotation on top of it,
			// so the spin always turns around the globe's own (tilted) polar
			// axis - the same composition this always used (rotation.set()
			// + rotateY()), just built as a quaternion so it can be slerped
			// against a "face the tracked flight" quaternion below without an
			// Euler-angle discontinuity. Object3D.rotateY() itself
			// post-multiplies the current quaternion by a local Y rotation,
			// which is exactly qBase.multiply(qSpin) below.
			const qBase = new this.THREE.Quaternion().setFromEuler(
				new this.THREE.Euler(degToRad(this.tiltX.current), degToRad(this.tiltY.current), degToRad(this.tiltZ.current))
			);
			const qSpin = new this.THREE.Quaternion().setFromAxisAngle(new this.THREE.Vector3(0, 1, 0), this.spinAngle);
			let qFinal = qBase.multiply(qSpin);

			// flights.track (see applyFlights()) slerps the globe's rotation
			// toward one that puts the tracked flight's current position
			// facing the camera - the globe (and, since it's a child of
			// threeGlobeObj, the background too) rotates to keep the flight
			// centered, rather than moving the camera itself. A literal
			// camera-follow was tried before and reverted for looking wrong
			// (OrbitControls keeps a fixed offset from its target, which
			// fought a moving target - see git history) - rotating the globe
			// instead sidesteps that entirely, and reuses getCoords(), the
			// same helper FlightLayer.mjs uses to place the marker itself, so
			// the "centered" point and the marker are always the same spot.
			// spinAngle keeps accumulating the whole time even at full blend,
			// so un-tracking resumes from wherever normal spin already is
			// instead of a frozen angle.
			const flightPosition = (this.flightLayer && this.flightTrackBlend.current > 0.001)
				? this.flightLayer.getCurrentPosition()
				: null;
			if (flightPosition && this.camera && this.controls) {
				const coords = this.threeGlobeObj.getCoords(flightPosition.lat, flightPosition.lng, 0);
				const pointLocal = new this.THREE.Vector3(coords.x, coords.y, coords.z).normalize();
				const cameraDirWorld = this.camera.position.clone().sub(this.controls.target).normalize();
				const qTrack = new this.THREE.Quaternion().setFromUnitVectors(pointLocal, cameraDirWorld);
				qFinal = qFinal.slerp(qTrack, this.flightTrackBlend.current);
			}

			this.threeGlobeObj.quaternion.copy(qFinal);
			this.threeGlobeObj.position.set(this.posX.current, this.posY.current, this.posZ.current);

			// The camera and its OrbitControls target are otherwise
			// deliberately left untouched here (position, not rotation) -
			// see the comment above for why panning the globe object itself,
			// not the camera, is what X/Y pan and flights.track both rely on.
		}

		// Manually orbiting while a flight is being tracked (or easing
		// into/out of it) would fight the auto-recentering happening above
		// every frame, so drag is locked for as long as any blend is active.
		if (this.controls) {
			this.controls.enableRotate = this.flightTrackBlend.current <= 0.001;
		}

		if (this.camera && this.controls && this.threeGlobeObj) {
			// Preserves the camera's current bearing, only changes its
			// distance from the target - lat/lng-driven framing (flights.track
			// above) is handled by rotating the globe instead, not by moving
			// the camera; this block only ever drives altitude from config.
			const offset = this.camera.position.clone().sub(this.controls.target);
			offset.setLength(this.threeGlobeObj.getGlobeRadius() * (1 + this.zoomAltitude.current));
			this.camera.position.copy(this.controls.target).add(offset);
			this.controls.update();
		}

		if (this.renderer && this.scene && this.camera && !this.occluded) {
			this.renderer.render(this.scene, this.camera);
			if (this.cssRenderer) {
				this.cssRenderer.render(this.scene, this.camera);
			}
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
			// A child of threeGlobeObj (see loadBackgroundTexture()) - already
			// disposed by disposeObject3D() above, just drop the now-stale
			// reference so applyBackground() rebuilds a fresh mesh next init().
			this.backgroundMesh = null;
			// Same story - StarfieldLayer's group is also a child of
			// threeGlobeObj (see ensureStarfieldLayer()), already swept up by
			// disposeObject3D() above.
			this.starfieldLayer = null;
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
		if (this.cssRenderer) {
			if (this.cssRenderer.domElement && this.cssRenderer.domElement.parentNode) {
				this.cssRenderer.domElement.parentNode.removeChild(this.cssRenderer.domElement);
			}
			this.cssRenderer = null;
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
		if (this.flightLayer) {
			this.flightLayer.destroy();
			this.flightLayer = null;
		}
		this.teardownScene();
	}
}

function rotationSpeedToDegPerSec(speed) {
	return (clamp(speed, 0, ROTATION_SPEED_SATURATION) / 100) * ROTATION_SPEED_MAX_DEG_PER_SEC;
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
