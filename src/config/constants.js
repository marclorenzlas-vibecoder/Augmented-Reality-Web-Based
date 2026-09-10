import * as THREE from 'three';

export const RETICLE_ACCENT = 0xee6327; // Bacolod Orange
export const RETICLE_LIGHT = 0xfbb03b;  // Bacolod Yellow

export const VIDEO_ASPECT = 9 / 16;
export const BILLBOARD_HEIGHT = 5.0;    // 5 meters scale
export const PLACEMENT_FLOAT_AMPLITUDE = 0.04;
export const PLANE_GRID_SURFACE_OFFSET = 0.003;

export const CAMERA_RELEASE_DELAY_MS = 100;

export const QR_CAMERA_CONFIG = {
  fps: 25,
  qrbox: (viewfinderWidth, viewfinderHeight) => {
    const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
    const size = Math.floor(minEdge * 0.88);
    return {
      width: Math.max(size, 200),
      height: Math.max(size, 200)
    };
  },
  aspectRatio: 1.0,
  disableFlip: false
};

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
