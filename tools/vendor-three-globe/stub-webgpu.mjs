// Stub for the "three/webgpu" subpath three-globe optionally imports for its
// alternate WebGPURenderer-based render path. MMM-Earth3D only ever uses the
// standard WebGLRenderer, so that path is dead weight - stubbing it out here
// avoids inlining three's real ~2MB three.webgpu.js build into the bundle.
export class WebGPURenderer {}
export class StorageInstancedBufferAttribute {}
