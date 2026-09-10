import * as THREE from 'three';
import { arState } from './state.js';
import { PLANE_GRID_SURFACE_OFFSET } from '../config/constants.js';
import { buildPlaneGridGeometry, isHorizontalDetectedPlane } from '../shaders/floorGridShader.js';

const hitTestMatrix = new THREE.Matrix4();
const planePoseMatrix = new THREE.Matrix4();

export function disposeDetectedPlaneGrid(context) {
  if (!context) return;
  arState.floorGridMesh?.remove(context.mesh);
  context.mesh.geometry?.dispose();
}

export function resetDetectedPlaneGrids() {
  arState.detectedPlaneGrids.forEach(disposeDetectedPlaneGrid);
  arState.detectedPlaneGrids.clear();
  arState.planeDetectionAvailable = false;
  arState.detectedFloorHeight = null;
  if (arState.fallbackFloorGridMesh) {
    arState.floorGridMesh?.remove(arState.fallbackFloorGridMesh);
    arState.fallbackFloorGridMesh.geometry?.dispose();
    arState.fallbackFloorGridMesh = null;
  }
  if (arState.floorGridMesh) arState.floorGridMesh.visible = false;
}

export function updateDetectedPlaneGrids(frame, referenceSpace, hitMatrix = null) {
  let detectedPlanes = null;
  try {
    detectedPlanes = frame.detectedPlanes;
  } catch (err) {
    detectedPlanes = null;
  }

  if (detectedPlanes && detectedPlanes.size > 0) {
    arState.planeDetectionAvailable = true;
    arState.detectedPlaneGrids.forEach((context, plane) => {
      if (!detectedPlanes.has(plane)) {
        disposeDetectedPlaneGrid(context);
        arState.detectedPlaneGrids.delete(plane);
      }
    });

    let visiblePlaneCount = 0;

    detectedPlanes.forEach((plane) => {
      const planePose = frame.getPose(plane.planeSpace, referenceSpace);
      let context = arState.detectedPlaneGrids.get(plane);

      if (!planePose || !isHorizontalDetectedPlane(plane, planePose)) {
        if (context) context.mesh.visible = false;
        return;
      }

      if (!context) {
        const geometry = buildPlaneGridGeometry(plane.polygon);
        if (!geometry) return;

        const mesh = new THREE.Mesh(geometry, arState.floorGridMaterial);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = 1;
        arState.floorGridMesh?.add(mesh);

        context = {
          mesh,
          polygon: plane.polygon,
          timestamp: plane.lastChangedTime
        };
        arState.detectedPlaneGrids.set(plane, context);
      } else if (context.timestamp < plane.lastChangedTime) {
        const geometry = buildPlaneGridGeometry(plane.polygon);
        if (geometry) {
          context.mesh.geometry.dispose();
          context.mesh.geometry = geometry;
          context.polygon = plane.polygon;
          context.timestamp = plane.lastChangedTime;
        }
      }

      context.mesh.matrix.fromArray(planePose.transform.matrix);
      // Floor grid sticks directly to all detected horizontal floor surfaces!
      context.mesh.visible = !arState.isPlaced;
      visiblePlaneCount++;

      planePoseMatrix.fromArray(planePose.transform.matrix);
      arState.detectedFloorHeight = planePoseMatrix.elements[13];
    });

    if (arState.floorGridMesh) {
      arState.floorGridMesh.visible = !arState.isPlaced && visiblePlaneCount > 0;
    }

    return visiblePlaneCount > 0;
  }

  // Anchor floor grid on hit-test detected surface
  if (hitMatrix && !arState.isPlaced) {
    hitTestMatrix.fromArray(hitMatrix);
    const hitPos = new THREE.Vector3().setFromMatrixPosition(hitTestMatrix);
    arState.detectedFloorHeight = hitPos.y;
    arState.lastHitPosition.copy(hitPos);

    if (!arState.fallbackFloorGridMesh) {
      const gridGeo = new THREE.PlaneGeometry(6, 6, 1, 1);
      gridGeo.rotateX(-Math.PI / 2);
      arState.fallbackFloorGridMesh = new THREE.Mesh(gridGeo, arState.floorGridMaterial);
      arState.fallbackFloorGridMesh.renderOrder = 1;
      arState.floorGridMesh?.add(arState.fallbackFloorGridMesh);
    }

    arState.fallbackFloorGridMesh.position.set(hitPos.x, hitPos.y + PLANE_GRID_SURFACE_OFFSET, hitPos.z);
    arState.fallbackFloorGridMesh.visible = !arState.isPlaced;

    if (arState.floorGridMesh) {
      arState.floorGridMesh.visible = !arState.isPlaced;
    }
    return true;
  }

  return false;
}
