import * as THREE from 'three';
import { arState } from './state.js';
import { BILLBOARD_HEIGHT, VIDEO_ASPECT } from '../config/constants.js';
import { createBillboardMaterial } from '../shaders/chromaShader.js';

export function buildVideoBillboard() {
  const group = new THREE.Group();

  let mat;
  let aspect = VIDEO_ASPECT;

  if (arState.currentTexture) {
    mat = createBillboardMaterial(arState.currentTexture);
    if (arState.currentTexture.image && arState.currentTexture.image.width && arState.currentTexture.image.height) {
      aspect = arState.currentTexture.image.width / arState.currentTexture.image.height;
    }
  } else {
    if (arState.videoTex) {
      arState.videoTex.dispose();
    }
    const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
    arState.videoTex = new THREE.VideoTexture(dancerVideo);
    arState.videoTex.minFilter = THREE.LinearFilter;
    arState.videoTex.magFilter = THREE.LinearFilter;
    arState.videoTex.generateMipmaps = false;
    arState.videoTex.colorSpace = THREE.SRGBColorSpace;

    mat = createBillboardMaterial(arState.videoTex);

    const vw = (dancerVideo && dancerVideo.videoWidth) ? dancerVideo.videoWidth : 720;
    const vh = (dancerVideo && dancerVideo.videoHeight) ? dancerVideo.videoHeight : 1280;
    aspect = (vw && vh) ? (vw / vh) : VIDEO_ASPECT;
  }

  const w = BILLBOARD_HEIGHT * aspect;
  arState.videoMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, BILLBOARD_HEIGHT),
    mat
  );

  arState.videoMesh.visible = arState.isMediaReady;
  arState.videoMesh.position.set(0, BILLBOARD_HEIGHT / 2, 0);
  group.add(arState.videoMesh);
  return group;
}

export function updateVideoBillboardGeometry() {
  const videoMesh = arState.videoMesh;
  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  if (!videoMesh || !dancerVideo) return;

  const vw = dancerVideo.videoWidth || 720;
  const vh = dancerVideo.videoHeight || 1280;
  const aspect = (vw && vh) ? (vw / vh) : VIDEO_ASPECT;
  const h = BILLBOARD_HEIGHT;
  const w = h * aspect;

  if (videoMesh.geometry) {
    videoMesh.geometry.dispose();
  }
  videoMesh.geometry = new THREE.PlaneGeometry(w, h);
  videoMesh.position.set(0, h / 2, 0);
}

export function applyVideoToBillboard() {
  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;
  if (arState.videoMesh) {
    arState.videoMesh.visible = arState.isMediaReady;
  }

  const dancerVideo = arState.dancerVideo || document.getElementById('dancer-video');
  if (!dancerVideo) return;

  if (arState.videoTex) {
    arState.videoTex.dispose();
  }

  arState.videoTex = new THREE.VideoTexture(dancerVideo);
  arState.videoTex.minFilter = THREE.LinearFilter;
  arState.videoTex.magFilter = THREE.LinearFilter;
  arState.videoTex.generateMipmaps = false;
  arState.videoTex.colorSpace = THREE.SRGBColorSpace;

  if (arState.videoMesh) {
    if (arState.videoMesh.material) arState.videoMesh.material.dispose();
    arState.videoMesh.material = createBillboardMaterial(arState.videoTex);
    arState.videoMesh.material.needsUpdate = true;
    updateVideoBillboardGeometry();
  }
}

export function applyTextureToBillboard(tex) {
  if (arState.currentGlbModel && arState.dancerGroup) {
    arState.dancerGroup.remove(arState.currentGlbModel);
    arState.currentGlbModel = null;
  }
  arState.mixer = null;
  if (arState.videoMesh) {
    arState.videoMesh.visible = arState.isMediaReady;
  }

  if (!arState.videoMesh) return;

  if (arState.videoMesh.material) arState.videoMesh.material.dispose();
  arState.videoMesh.material = createBillboardMaterial(tex);
  arState.videoMesh.material.needsUpdate = true;

  const aspect = (tex.image && tex.image.width && tex.image.height)
    ? (tex.image.width / tex.image.height)
    : VIDEO_ASPECT;
  const h = BILLBOARD_HEIGHT;
  const w = h * aspect;

  if (arState.videoMesh.geometry) arState.videoMesh.geometry.dispose();
  arState.videoMesh.geometry = new THREE.PlaneGeometry(w, h);
  arState.videoMesh.position.set(0, h / 2, 0);
}

export function createGroundOcclusionShadow() {
  const geo = new THREE.PlaneGeometry(1.5, 1.5);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x000000) },
      uOpacity: { value: 0.55 }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;

      void main() {
        vec2 center = vUv - vec2(0.5);
        float dist = length(center);

        if (dist > 0.5) discard;

        float coreShadow = (1.0 - smoothstep(0.0, 0.16, dist)) * 0.7;
        float outerShadow = (1.0 - smoothstep(0.1, 0.5, dist)) * 0.35;

        float alpha = (coreShadow + outerShadow) * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(0, 0.002, 0);
  return mesh;
}

export function buildParticles() {
  const N = 36;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);

  const palette = [
    new THREE.Color('#d4b483'),
    new THREE.Color('#e8c98a'),
    new THREE.Color('#a87b48'),
    new THREE.Color('#ffffff'),
  ];

  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 2.2;
    pos[i * 3 + 1] = Math.random() * 1.6 - 0.3;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 2.2;
    const c = palette[i % palette.length];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  return new THREE.Points(geo, new THREE.PointsMaterial({
    size: 0.035, vertexColors: true, transparent: true, opacity: 0.6
  }));
}
