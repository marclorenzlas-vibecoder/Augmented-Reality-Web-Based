import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

export const arState = {
  // Three.js instances
  scene: null,
  camera: null,
  renderer: null,
  controller: null,

  // 3D Objects & Billboard
  dancerGroup: null,
  videoMesh: null,
  videoTex: null,
  currentGlbModel: null,
  groundShadowMesh: null,
  mixer: null,
  gltfLoader,

  // GIF state
  gifCanvas: null,
  gifTexture: null,
  currentGifPlayer: null,
  isGifMediaType: false,

  // Media state
  dancerVideo: null,
  currentMediaUrl: null,
  currentMediaType: 'default', // 'video' | 'image' | 'default' | '3d'
  currentTexture: null,
  isMediaReady: false,
  mediaLoadToken: 0,
  currentBlobUrl: null,

  // Session and placement state
  isPlaced: false,
  arStarted: false,
  isSurfaceDetected: false,
  isThreeInitialized: false,
  ignorePlacementUntil: 0,
  placementListenerAttached: false,
  handlePlacementTap: null,

  // Fallback Camera AR mode (Mozilla Firefox, iOS Safari & non-WebXR devices)
  isFallbackMode: false,
  cameraStream: null,
  deviceOrientationHandler: null,
  deviceOrientationData: { alpha: 0, beta: 0, gamma: 0 },
  deviceOrientationActive: false,
  fallbackBasePosition: new THREE.Vector3(0, -0.48, -2.1),

  // WebXR Hit test & plane detection
  hitTestSource: null,
  hitTestSourceRequested: false,
  floorGridMesh: null,
  floorGridMaterial: null,
  fallbackFloorGridMesh: null,
  detectedFloorHeight: null,
  lastHitPosition: new THREE.Vector3(),
  lastHitPoseMatrix: null,
  detectedPlaneGrids: new Map(),
  planeDetectionAvailable: false,

  // Chroma key state (defaults to Mode 3: Grey Screen for Composition_greybg.mp4)
  currentKeyMode: 3,
  currentKeyColor: new THREE.Color(83 / 255, 83 / 255, 83 / 255),
  currentSimilarity: 0.22,
  currentSmoothness: 0.08,
  hasFilenameKeyTag: false,

  // Audio state
  audioListener: null,
  positionalAudio: null,
  audioLoader: null,
  currentAudioUrl: null,
  audioBuffer: null,
  isAudioReady: false,
  isAudioMuted: false,
  audioLoadToken: 0,
  dancerAudioEl: null,
  lastAudioSyncTime: 0,

  // Touch & orientation coordinates
  lastTapScreenX: null,
  lastTapScreenY: null,
  initialPinchDist: null,
  basePinchScale: 1.0,
  currentDancerScale: 1.0,
  xrLastLandscape: null,
  currentOrientationIsLandscape: null,
  currentOrientationState: { isLandscape: false, angle: 0 },
  isTransitioningOrientation: false,
  pendingOrientationTarget: null,
  orientationTransitionTimer: null,
  lastDeviceOrientationAngle: null,
  lastDeviceOrientationTimestamp: 0,
  lastOrientationAngle: null,

  // QR state
  html5QrCode: null,
  availableCameras: [],
  selectedCameraIndex: 0,
  qrCameraTask: Promise.resolve(),
  isQrProcessing: false,
  activeQrCameraId: null,
  restartQrTimer: null,

  // Geolocation state
  isLocationVerified: false,

  // Capture state
  captureRenderTarget: null,
  isCaptureRequested: false,
  capturePromiseResolver: null,
  cameraBackgroundScene: null,
  cameraBackgroundQuad: null,
  cameraBackgroundMaterial: null
};
