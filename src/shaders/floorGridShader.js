import * as THREE from 'three';
import { arState } from '../ar/state.js';
import { PLANE_GRID_SURFACE_OFFSET } from '../config/constants.js';

export const FloorGridShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0xee6327) },          // Bacolod Orange
    uColorSecondary: { value: new THREE.Color(0xfbb03b) }  // Bacolod Yellow
  },
  vertexShader: `
    varying vec3 vPlanePosition;
    void main() {
      vPlanePosition = position;
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform vec3 uColorSecondary;
    varying vec3 vPlanePosition;

    void main() {
      // Local plane coordinates keep the pattern aligned to each detected surface.
      vec2 gridWorld = vPlanePosition.xz * 6.0;
      vec2 grid = abs(fract(gridWorld - 0.5) - 0.5) / fwidth(gridWorld);
      float line = min(grid.x, grid.y);
      float gridAlpha = clamp(1.0 - min(line, 1.0), 0.0, 1.0);

      // Fine secondary grid lines
      vec2 fineGridWorld = vPlanePosition.xz * 18.0;
      vec2 fineGrid = abs(fract(fineGridWorld - 0.5) - 0.5) / fwidth(fineGridWorld);
      float fineLine = min(fineGrid.x, fineGrid.y);
      float fineGridAlpha = clamp((1.0 - min(fineLine, 1.0)) * 0.35, 0.0, 1.0);

      float totalGrid = max(gridAlpha, fineGridAlpha);

      // Completely discard fragments between grid lines: zero dark fill, 100% transparent plane body
      if (totalGrid <= 0.02) discard;

      // Pulsating wave animation radiating across floor plane grid lines
      float distWorld = length(vPlanePosition.xz);
      float wave = sin(distWorld * 3.5 - uTime * 3.5) * 0.5 + 0.5;
      float timePulse = sin(uTime * 2.5) * 0.15 + 0.85;

      // Color composition matching Bacolod theme
      vec3 gridColor = mix(uColorSecondary, uColor, wave * 0.75);

      // Only the wireframe grid lines render with vivid color and opacity
      float alpha = clamp(totalGrid * timePulse, 0.0, 1.0);

      gl_FragColor = vec4(gridColor, alpha);
    }
  `
};

export function buildPulsatingFloorGrid() {
  arState.floorGridMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xee6327) },
      uColorSecondary: { value: new THREE.Color(0xfbb03b) }
    },
    vertexShader: FloorGridShader.vertexShader,
    fragmentShader: FloorGridShader.fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  });

  arState.floorGridMesh = new THREE.Group();
  arState.floorGridMesh.visible = false;
  return arState.floorGridMesh;
}

export function buildPlaneGridGeometry(polygon) {
  if (!polygon || polygon.length < 3) return null;

  const points = [];
  for (const point of polygon) {
    const previous = points[points.length - 1];
    if (
      previous &&
      Math.abs(previous.x - point.x) < 0.0001 &&
      Math.abs(previous.z - point.z) < 0.0001
    ) {
      continue;
    }
    points.push(point);
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (
    points.length > 2 &&
    Math.abs(first.x - last.x) < 0.0001 &&
    Math.abs(first.z - last.z) < 0.0001
  ) {
    points.pop();
  }

  if (points.length < 3) return null;

  const vertices = [];
  const uvs = [];
  const contour = [];

  for (const point of points) {
    vertices.push(point.x, point.y + PLANE_GRID_SURFACE_OFFSET, point.z);
    uvs.push(point.x, point.z);
    contour.push(new THREE.Vector2(point.x, point.z));
  }

  let triangles = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!triangles.length) {
    triangles = [];
    for (let i = 2; i < points.length; i++) {
      triangles.push([0, i - 1, i]);
    }
  }

  const indices = [];
  for (const triangle of triangles) {
    indices.push(triangle[0], triangle[1], triangle[2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

export function pointInDetectedPlanePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const zi = polygon[i].z;
    const xj = polygon[j].x;
    const zj = polygon[j].z;
    const intersects = ((zi > point.z) !== (zj > point.z)) &&
      (point.x < ((xj - xi) * (point.z - zi)) / (zj - zi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

const planePoseMatrix = new THREE.Matrix4();
const planeWorldNormal = new THREE.Vector3();

export function isHorizontalDetectedPlane(plane, planePose) {
  if (plane.orientation && plane.orientation !== 'horizontal') return false;

  planePoseMatrix.fromArray(planePose.transform.matrix);
  planeWorldNormal.setFromMatrixColumn(planePoseMatrix, 1).normalize();
  return Math.abs(planeWorldNormal.y) > 0.85;
}
