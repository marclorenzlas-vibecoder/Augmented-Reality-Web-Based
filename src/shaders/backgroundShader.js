import * as THREE from 'three';
import { arState } from '../ar/state.js';

export function getCameraBackgroundMesh() {
  if (!arState.cameraBackgroundQuad) {
    const geo = new THREE.PlaneGeometry(2, 2);
    arState.cameraBackgroundMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(map, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false
    });
    arState.cameraBackgroundQuad = new THREE.Mesh(geo, arState.cameraBackgroundMaterial);
    arState.cameraBackgroundScene = new THREE.Scene();
    arState.cameraBackgroundScene.add(arState.cameraBackgroundQuad);
  }
  return {
    scene: arState.cameraBackgroundScene,
    quad: arState.cameraBackgroundQuad,
    mat: arState.cameraBackgroundMaterial
  };
}
