/* global EarthCompositor, Log */

// Earth3DRenderer: owns the three-globe/Three.js scene for MMM-Earth3D, kept separate from the MM module file; Three.js/three-globe/OrbitControls load via dynamic import() (see loadThreeGlobeDeps()) sharing one Three.js instance.

// rotationSpeed config (0-100, saturates at 25 - see ROTATION_SPEED_SATURATION) maps onto degrees/second of manual spin.
const ROTATION_SPEED_MAX_DEG_PER_SEC = 10; // 100 -> full revolution every 36s, if it were reachable

// 25 and above all produce the same speed (one revolution every 144s) - the full 0-100 range felt too fast well before 100.
const ROTATION_SPEED_SATURATION = 25;

// camera.zoom maps onto camera distance in globe radii - 0-100 is the original range; 100-200 extends further in for framing something small (flight marker, city) tightly.
const ZOOM_ALTITUDE_MIN = 0.5; // zoom:100 -> close
const ZOOM_ALTITUDE_MAX = 5; // zoom:0   -> far
const ZOOM_EXTENDED_MAX = 200; // top of the extended close-up range
const ZOOM_ALTITUDE_SUPER_MIN = 0.05; // zoom:200 -> very close

// The flight marker's geometry (see FlightLayer.mjs) is sized to look right at this zoom - tick() scales it against the current distance relative to this reference for a constant on-screen size.
const FLIGHT_MARKER_REFERENCE_ZOOM = 50;

// Live config changes ease in over this long instead of jumping.
const TRANSITION_MS = 700;

// centerOnCity()'s one-shot spin animation - longer than TRANSITION_MS since it can cover up to a half-turn of the globe.
const CENTER_ON_CITY_TRANSITION_MS = 2000;

// setupInteraction(): scroll-zoom step per wheel event (in the same 0-200 units as config.camera.zoom) and how long each step tweens over.
const WHEEL_ZOOM_STEP = 4;
const WHEEL_ZOOM_TWEEN_MS = 150;

// setupInteraction(): matches planet-env.html's positionX/Y slider range - Shift-drag panning clamps to the same bounds.
const POSITION_BOUND = 200;

// setupInteraction(): how long after the last wheel/drag event before the gesture's result is pinned into the module's tracked override.
const INTERACTIVE_COMMIT_DEBOUNCE_MS = 500;

// How often to check whether another opaque layer (e.g. a sibling fullscreen_below module) is covering the globe - a plain interval, not a per-frame check.
const OCCLUSION_CHECK_MS = 1000;

// quality presets: sphere tessellation, antialiasing, device-pixel-ratio cap, and which resolution key to request from the texture preset's `images` map.
const QUALITY_PRESETS = {
	low: { curvatureResolution: 10, antialias: false, maxPixelRatio: 1, textureRes: "2k" },
	medium: { curvatureResolution: 6, antialias: true, maxPixelRatio: 1, textureRes: "2k" },
	high: { curvatureResolution: 3, antialias: true, maxPixelRatio: 2, textureRes: "4k" },
	ultra: { curvatureResolution: 1, antialias: true, maxPixelRatio: 3, textureRes: "8k" }
};

// Background: a giant textured sphere viewed from inside, attached as a child of the globe's rotating group so it spins in lockstep - radius sized well inside the camera's far plane and outside its max orbit distance.
const BACKGROUND_SPHERE_RADIUS_MULTIPLIER = 30;
const BACKGROUND_SPHERE_SEGMENTS = 32; // viewed from deep inside a huge radius - no need for globe-grade tessellation

// Camera fov matches this module's historical default (THREE.PerspectiveCamera's own 50); near/far sized to what this module actually renders (max camera distance = globeRadius * 6).
const CAMERA_FOV = 50;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR_MULTIPLIER = 50; // far = globeRadius * this

// enableZoom is always false (see createControls()), so these bounds are inert in practice - set anyway for parity/explicitness.
const CONTROLS_MIN_DISTANCE = 0.1;
const CONTROLS_MAX_DISTANCE_MULTIPLIER = 50; // maxDistance = globeRadius * this

// Matches this module's historical look (previously hidden inside the render library's own defaults), now first-class local constants.
const AMBIENT_LIGHT_COLOR = 0xcccccc;
const AMBIENT_LIGHT_INTENSITY = Math.PI;
const KEY_LIGHT_COLOR = 0xffffff;
const KEY_LIGHT_INTENSITY = 0.6 * Math.PI;

// texture.preset "tile-engine" (presets/earthTextures.js): NASA GIBS' static Blue Marble tile pyramid, not OSM - no key, and GIBS is built for exactly this kind of distributed client polling (unlike OSM's tile server, which asks embedded apps not to hotlink it).
const GIBS_TILE_MAX_LEVEL = 8; // GoogleMapsCompatible_Level8 - three-globe reuses these tiles past this depth instead of requesting ones that don't exist
function gibsBlueMarbleTileUrl(x, y, level) {
	return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/${level}/${y}/${x}.jpeg`;
}

// Loads three-globe + OrbitControls + CSS2DRenderer, sharing one Three.js instance with no window globals; CSS2DRenderer is what actually mounts three-globe's htmlElementsData markers (the city label) into the DOM.
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

// Eases a single number to a target over a fixed duration - used for every live-tunable property so changes glide instead of jumping.
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
	constructor(container, config, cacheBust, onInteractiveCameraChange) {
		this.container = container;
		this.config = config;
		// Only applied to CloudsLayer.mjs/FlightLayer.mjs's own imports, not loadThreeGlobeDeps()'s three - cache-busting those would fragment the single-shared-THREE guarantee.
		this.cacheBust = cacheBust ? ("?v=" + cacheBust) : "";
		// Fired once a Shift+drag/scroll gesture settles (see setupInteraction()) so MMM-Earth3D.js can pin the result into the tracked override.
		this.onInteractiveCameraChange = onInteractiveCameraChange || null;

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
		this.zoomAltitude = new TweenedValue(this.zoomToAltitude(config.camera.zoom));
		// Reference camera distance the flight marker's geometry was authored to look right at - tick() divides current distance by this to counteract perspective for a constant on-screen size.
		this.flightMarkerReferenceDistance = 1 + this.zoomToAltitude(FLIGHT_MARKER_REFERENCE_ZOOM);
		this.spinRate = new TweenedValue(rotationSpeedToDegPerSec(config.rotationSpeed));
		this.spinAngle = 0;
		// 0 = normal spin/tilt (flights.track off), 1 = fully blended toward facing the tracked flight (see applyFlights()/tick()).
		this.flightTrackBlend = new TweenedValue(0);
		// Set by centerOnCity() - a one-shot override driving spinAngle to a target over CENTER_ON_CITY_TRANSITION_MS, then clears itself so normal spin resumes from wherever it landed.
		this.spinOverrideTween = null;
		this.lastFrameTime = null;

		this.init();

		// container.style.width/height may be px or "100vw"/"100vh" - track the container's actual rendered size instead of trusting config.width/height, kept in sync as the screen resizes.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.container);

		// Some MM setups stack more than one fullscreen_below module with no explicit z-index, so a later one can paint over this one - checkOcclusion() sets this.occluded, and tick() skips the draw call while covered.
		this.occluded = false;
		this.occlusionInterval = setInterval(() => this.checkOcclusion(), OCCLUSION_CHECK_MS);
	}

	// Hit-tests the container's center point - catches occlusion by a default-pointer-events element, not one with pointer-events:none (elementFromPoint skips those).
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

	// Falls back to config.width/height (then 500) only before the container has been laid out at all.
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

		// Only loaded once - a quality-triggered rebuild (see applyQuality()) finds these already cached.
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
		// Tile mode owns the color map directly (globeTileEngineUrl) - the day/night compositor and globeImageUrl are mutually exclusive on the same three-globe material, so it's left unstarted (clouds/day-night stay off for this preset).
		if (textures.tileEngine) {
			this.applyTileEngine();
		} else {
			this.compositor.start(textures.image);
		}

		this.startRenderLoop();
	}

	createRenderer(quality, size) {
		this.renderer = new this.THREE.WebGLRenderer({ antialias: quality.antialias, alpha: true });
		this.renderer.setClearColor(0x000000, 0);
		this.renderer.setPixelRatio(Math.min(quality.maxPixelRatio, window.devicePixelRatio));
		this.renderer.setSize(size.width, size.height, false);
		this.container.appendChild(this.renderer.domElement);
	}

	// Overlays the WebGL canvas with a same-sized DOM layer for three-globe's htmlElementsData markers (the city label); pointer-events: none so it never blocks occlusion checks or OrbitControls.
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

	// The composited day/night color map is set later by the compositor's onReady callback, once it has finished layering day/night.
	createGlobe(textures, quality) {
		this.threeGlobeObj = new this.ThreeGlobeCtor()
			.bumpImageUrl(textures.bump)
			.globeCurvatureResolution(quality.curvatureResolution);
		this.scene.add(this.threeGlobeObj);
	}

	// Created after createGlobe() so the far plane can size against the globe's real radius - initial position is an arbitrary +Z unit vector, scaled to the real distance by applyZoom() before the first frame renders.
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
		// Spin is applied manually each frame around the globe's own local axis (correctly follows tilt) - OrbitControls' autoRotate orbits the world axis instead, wrong once tilted.
		this.controls.autoRotate = false;
		this.controls.enableZoom = false;
		// Both handled manually by setupInteraction() instead: zoom drives config.camera.zoom (not camera distance directly), and pan moves the globe object, not the camera/target.
		this.controls.enablePan = false;
		this.controls.minDistance = CONTROLS_MIN_DISTANCE;
		this.controls.maxDistance = this.threeGlobeObj.getGlobeRadius() * CONTROLS_MAX_DISTANCE_MULTIPLIER;
		this.setupInteraction();
	}

	// Shift+drag pans the globe on the X/Y plane (config.camera.position); plain scroll zooms (config.camera.zoom) - both tween instantly for direct-manipulation feel, then commit back to the module once the gesture settles so the resolved config (and control.html's next read of it) picks it up.
	setupInteraction() {
		const el = this.renderer.domElement;
		el.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
		el.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
	}

	handleWheel(event) {
		event.preventDefault();
		const step = event.deltaY > 0 ? -WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
		const zoom = clamp(this.config.camera.zoom + step, 0, ZOOM_EXTENDED_MAX);
		this.config.camera.zoom = zoom;
		this.zoomAltitude.setTarget(this.zoomToAltitude(zoom), WHEEL_ZOOM_TWEEN_MS);
		this.scheduleInteractiveCommit({ zoom });
	}

	handlePointerDown(event) {
		if (!event.shiftKey || !this.controls || this.flightTrackBlend.current > 0.001) {
			return;
		}
		event.preventDefault();
		const wasRotateEnabled = this.controls.enableRotate;
		this.controls.enableRotate = false;
		let lastX = event.clientX;
		let lastY = event.clientY;
		const onMove = (moveEvent) => {
			this.panGlobe(moveEvent.clientX - lastX, moveEvent.clientY - lastY);
			lastX = moveEvent.clientX;
			lastY = moveEvent.clientY;
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			this.controls.enableRotate = wasRotateEnabled;
			this.config.camera.position.x = this.posX.to;
			this.config.camera.position.y = this.posY.to;
			this.scheduleInteractiveCommit({ position: { x: this.posX.to, y: this.posY.to } });
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	// Converts a screen-pixel drag delta into a world-space offset along the camera's current screen-aligned right/up axes (same approach OrbitControls' own pan uses), then drops the resulting Z component - the globe's position is X/Y only.
	panGlobe(deltaPixelX, deltaPixelY) {
		const THREE = this.THREE;
		const distance = this.camera.position.distanceTo(this.controls.target);
		const visibleHeight = 2 * distance * Math.tan(degToRad(this.camera.fov) / 2);
		const unitsPerPixel = visibleHeight / this.renderer.domElement.clientHeight;
		const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
		const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
		const offset = right.multiplyScalar(-deltaPixelX * unitsPerPixel).add(up.multiplyScalar(deltaPixelY * unitsPerPixel));
		// Integer scene units to match the control panel's whole-number position sliders - a sub-pixel drag can otherwise leave posX/posY with long decimal tails.
		const newX = clamp(Math.round(this.posX.to + offset.x), -POSITION_BOUND, POSITION_BOUND);
		const newY = clamp(Math.round(this.posY.to + offset.y), -POSITION_BOUND, POSITION_BOUND);
		this.posX.setTarget(newX, 0);
		this.posY.setTarget(newY, 0);
	}

	scheduleInteractiveCommit(patch) {
		this.pendingInteractiveCommit = Object.assign(this.pendingInteractiveCommit || {}, patch);
		clearTimeout(this.interactiveCommitTimer);
		this.interactiveCommitTimer = setTimeout(() => {
			const pending = this.pendingInteractiveCommit;
			this.pendingInteractiveCommit = null;
			if (this.onInteractiveCameraChange) {
				this.onInteractiveCameraChange(pending);
			}
		}, INTERACTIVE_COMMIT_DEBOUNCE_MS);
	}

	startRenderLoop() {
		if (this.animating) {
			return;
		}
		this.animating = true;
		requestAnimationFrame((now) => this.tick(now));
	}

	// Live-update entry points: config is shared by reference with the module instance - callers mutate this.config, then call the matching apply*().

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
	}

	// Antialiasing can't change on an existing WebGL context, so quality changes rebuild the scene - tween/spin state is left untouched, and the texture resolution key is re-picked for the new tier.
	applyQuality() {
		this.debugLog("applyQuality", this.config.quality);
		// Destroy cloudsLayer BEFORE the globe - avoids a double-dispose when teardownScene() walks the scene; init() rebuilds it fresh.
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

	// Regular chainable three-globe props apply live with no rebuild; opacity isn't native to three-globe, approximated here as a visibility threshold.
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

	// The color map goes through the compositor instead of globeImageUrl directly, since the night layer blends on top of it.
	applyTexture() {
		const textures = this.resolveTextureUrls();
		this.debugLog("applyTexture", textures);
		if (textures.tileEngine) {
			this.applyTileEngine();
			return;
		}
		if (this.threeGlobeObj) {
			// three-globe keeps its globeObj hidden while globeTileEngineUrl is set, even after globeImageUrl changes - must clear it to leave tile-engine mode.
			this.threeGlobeObj.globeTileEngineUrl(null);
			if (textures.bump) {
				this.threeGlobeObj.bumpImageUrl(textures.bump);
			}
		}
		if (this.compositor) {
			this.compositor.setDayImage(textures.image);
		}
	}

	// Live, zoomable NASA GIBS satellite tiles instead of the fixed-resolution day/night composite - see GIBS_TILE_MAX_LEVEL above for why level is capped.
	applyTileEngine() {
		if (!this.threeGlobeObj) {
			return;
		}
		this.debugLog("applyTileEngine");
		this.threeGlobeObj.globeTileEngineUrl(gibsBlueMarbleTileUrl).globeTileEngineMaxLevel(GIBS_TILE_MAX_LEVEL);
	}

	// Toggles/swaps the background sphere or starfield layer; disabling just hides the current one rather than disposing it, so re-enabling is instant.
	applyBackground() {
		const selection = this.resolveBackgroundSelection();
		this.debugLog("applyBackground", selection);
		this.applyStarfield(selection);
		if (!selection) {
			if (this.backgroundMesh) {
				this.backgroundMesh.visible = false;
			}
			return;
		}
		if (selection.type === "starfield") {
			if (this.backgroundMesh) {
				this.backgroundMesh.visible = false;
			}
			return;
		}
		if (this.backgroundMesh && this.backgroundMesh.userData.url === selection.url) {
			this.backgroundMesh.visible = true;
			return;
		}
		this.loadBackgroundTexture(selection.url);
	}

	// Pushes background.starfield's count/size/color/etc into the star point-clouds and toggles their visibility - selection is applyBackground()'s already-resolved choice.
	applyStarfield(selection) {
		if (!this.starfieldLayer) {
			return;
		}
		const starfield = this.config.background.starfield;
		this.debugLog("applyStarfield", starfield);
		this.starfieldLayer.setVisible(Boolean(selection && selection.type === "starfield"));
		this.starfieldLayer.setConfig(starfield);
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

	// requestId guards against a slow-loading earlier request clobbering a newer one that already finished.
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
				// Mirrored (not BackSide) so the inside view isn't texture-flipped - BackSide alone reverses apparent rotation vs the globe.
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

	// Live-update entry point for the day/night layer.
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
			this.cloudsLayer.setDynamic(this.config.clouds.source === "dynamic");
		}
		if (this.compositor) {
			this.compositor.applyCloudsConfig();
		}
	}

	// flights.enabled/pollInterval drive marker/interpolation timing; flights.track drives tick()'s rotation blend toward facing the tracked flight.
	applyFlights() {
		const flights = this.config.flights;
		this.debugLog("applyFlights", flights, "flightLayer ready:", Boolean(this.flightLayer));
		if (this.flightLayer) {
			this.flightLayer.setVisible(flights.enabled);
			this.flightLayer.setPollIntervalMs(flights.pollInterval * 1000);
		}
		this.flightTrackBlend.setTarget(flights.enabled && flights.track ? 1 : 0, TRANSITION_MS);
	}

	// Live telemetry from node_helper's OpenSky poller - not a config field, so called directly from MMM-Earth3D.js's socketNotificationReceived.
	updateFlightPosition(data) {
		this.debugLog("updateFlightPosition", data, "flightLayer ready:", Boolean(this.flightLayer));
		if (this.flightLayer) {
			this.flightLayer.pushSample(data);
		}
	}

	// city.cities entries already have lat/lng resolved by MMM-Earth3D.js's resolveCity() - one htmlElementsData entry per city so each marker (dot + label) is a styleable DOM element, not baked-in 3D text geometry.
	applyCity() {
		if (!this.threeGlobeObj) {
			return;
		}
		const city = this.config.city;
		this.debugLog("applyCity", city);
		const cities = (city && city.cities) ? city.cities.filter((c) => c.lat !== null && c.lng !== null) : [];
		if (!cities.length) {
			this.threeGlobeObj.htmlElementsData([]);
			return;
		}
		this.threeGlobeObj
			.htmlElementsData(cities)
			.htmlLat("lat")
			.htmlLng("lng")
			.htmlAltitude(0.01)
			.htmlElement((c) => this.createCityMarkerElement(c));
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

	// Eases the globe's spin (only spinAngle, not tilt) so the given lat/lng faces the camera, by projecting city and camera direction onto the plane perpendicular to the tilted polar axis and solving the angle between them; undefined (city on the axis) leaves spin alone.
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

		// spinAngle accumulates without wrapping, so pick the full-turn offset of targetAngle nearest the current spinAngle for the shortest visible rotation.
		const twoPi = Math.PI * 2;
		const target = targetAngle + Math.round((this.spinAngle - targetAngle) / twoPi) * twoPi;
		this.debugLog("centerOnCity", { lat, lng, from: this.spinAngle, to: target });
		this.spinOverrideTween = { from: this.spinAngle, to: target, startTime: performance.now(), duration: CENTER_ON_CITY_TRANSITION_MS };
	}

	// Kept here (not just forwarded to the compositor) since the compositor might not exist yet if this arrives before DOM_OBJECTS_CREATED.
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
		if (preset.texture.tileEngine) {
			return { image: null, bump: null, tileEngine: true };
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

	// Piecewise so the existing 0-100 mapping is unaffected, while 100-200 extends into a second closer sub-range instead of extrapolating (which would go negative past zoom:100).
	zoomToAltitude(zoom) {
		const z = clamp(zoom, 0, ZOOM_EXTENDED_MAX);
		if (z <= 100) {
			const t = z / 100;
			return ZOOM_ALTITUDE_MAX - t * (ZOOM_ALTITUDE_MAX - ZOOM_ALTITUDE_MIN);
		}
		const t = (z - 100) / (ZOOM_EXTENDED_MAX - 100);
		return ZOOM_ALTITUDE_MIN - t * (ZOOM_ALTITUDE_MIN - ZOOM_ALTITUDE_SUPER_MIN);
	}

	// CloudsLayer.mjs is loaded via dynamic import() rather than MM's getScripts(), since MM core's script loader can silently no-op on an unrecognized extension on some versions.
	ensureCloudsLayer() {
		if (this.cloudsLayer || this.cloudsLayerImporting || this.destroyed) {
			return;
		}
		this.cloudsLayerImporting = true;
		// Relative specifier resolves against this script's own file URL (dynamic import()'s base in a classic script), so "./" is enough.
		import("./CloudsLayer.mjs" + this.cacheBust)
			.then((module) => {
				this.cloudsLayerImporting = false;
				if (this.destroyed || this.cloudsLayer) {
					return;
				}
				this.cloudsLayer = new module.CloudsLayer(this.threeGlobeObj.getGlobeRadius(), Boolean(this.config.debug));
				if (this.pendingCloudsImage) {
					this.applyCloudsImage(this.pendingCloudsImage);
				} else {
					// Mirrors ensureFlightLayer()/ensureStarfieldLayer() syncing current config right after construction - without this, a clouds toggle that landed during this import stays unapplied until an image happens to load.
					this.cloudsLayer.setOpacity(this.config.clouds.opacity);
					this.cloudsLayer.setVisible(this.config.clouds.enabled);
					this.cloudsLayer.setDynamic(this.config.clouds.source === "dynamic");
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

	// FlightLayer.mjs is loaded the same way and for the same reason as CloudsLayer.mjs above.
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
			.then((module) => module.StarfieldLayer.create(this.threeGlobeObj.getGlobeRadius(), Boolean(this.config.debug), this.config.background.starfield, this.cacheBust))
			.then((layer) => {
				this.starfieldLayerImporting = false;
				if (this.destroyed || this.starfieldLayer) {
					return;
				}
				this.starfieldLayer = layer;
				if (this.threeGlobeObj) {
					this.starfieldLayer.attachTo(this.threeGlobeObj);
				}
				this.applyStarfield(this.resolveBackgroundSelection());
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
		this.cloudsLayer.setDynamic(this.config.clouds.source === "dynamic");
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
			this.flightLayer.setDistanceScale((1 + this.zoomAltitude.current) / this.flightMarkerReferenceDistance);
			this.flightLayer.tick(now);
		}
		if (this.starfieldLayer) {
			this.starfieldLayer.tick(now);
		}

		if (this.threeGlobeObj) {
			// Base orientation: tweened fixed tilt with accumulated spin applied as a local-axis rotation on top, built as a quaternion so it can slerp against the flight-tracking quaternion below without an Euler discontinuity.
			const qBase = new this.THREE.Quaternion().setFromEuler(
				new this.THREE.Euler(degToRad(this.tiltX.current), degToRad(this.tiltY.current), degToRad(this.tiltZ.current))
			);
			const qSpin = new this.THREE.Quaternion().setFromAxisAngle(new this.THREE.Vector3(0, 1, 0), this.spinAngle);
			let qFinal = qBase.multiply(qSpin);

			// flights.track slerps the globe's rotation to face the tracked flight toward the camera (rotating the globe, not the camera - a literal camera-follow fought OrbitControls' fixed target offset, see git history); spinAngle keeps accumulating so un-tracking resumes from wherever it landed.
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
			this.threeGlobeObj.position.set(this.posX.current, this.posY.current, 0);
			// The camera/OrbitControls target are deliberately left untouched - X/Y pan and flights.track both rely on panning the globe object itself.
		}

		// Manual orbiting while a flight is tracked would fight the auto-recentering above, so drag is locked while any blend is active.
		if (this.controls) {
			this.controls.enableRotate = this.flightTrackBlend.current <= 0.001;
		}

		if (this.camera && this.controls && this.threeGlobeObj) {
			// Preserves the camera's bearing, only changes distance from the target - this block only ever drives altitude from config.
			const offset = this.camera.position.clone().sub(this.controls.target);
			offset.setLength(this.threeGlobeObj.getGlobeRadius() * (1 + this.zoomAltitude.current));
			this.camera.position.copy(this.controls.target).add(offset);
			this.controls.update();
			// three-globe's tile engine only fetches/builds tiles in response to this call - without it globeTileEngineUrl mode never requests a single tile and renders fully transparent.
			this.threeGlobeObj.setPointOfView(this.camera);
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

	// Walks an Object3D's subtree disposing every geometry/material/texture it finds, instead of hand-listing every possible map name.
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

	// Full teardown of everything created in createRenderer()/createScene()/.../createControls() - used by destroy() and applyQuality()'s rebuild, since Three.js/three-globe have no single all-in-one destructor.
	teardownScene() {
		if (this.threeGlobeObj) {
			this.disposeObject3D(this.threeGlobeObj);
			if (this.scene) {
				this.scene.remove(this.threeGlobeObj);
			}
			this.threeGlobeObj = null;
			// Already disposed by disposeObject3D() above - just drop the stale reference so applyBackground() rebuilds fresh next init().
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
