import * as THREE from 'three';
import { arState } from '../ar/state.js';

export const ChromaShader = {
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision mediump float;
    uniform sampler2D map;
    uniform int keyMode;
    uniform vec3 keyColor;
    uniform float similarity;
    uniform float smoothness;
    varying vec2 vUv;

    void main() {
      vec4 texColor = texture2D(map, vUv);
      if (texColor.a < 0.05) {
        discard;
      }

      if (keyMode == 0) {
        // Mode 0: GIF / Image native transparency with vibrant sRGB gamma correction
        vec3 col = pow(texColor.rgb, vec3(1.0 / 2.2));
        gl_FragColor = vec4(col, texColor.a);
      } else if (keyMode == 1) {
        // Green Screen Chroma Key with Green Despill
        float Y1 = 0.299 * keyColor.r + 0.587 * keyColor.g + 0.114 * keyColor.b;
        float Cb1 = -0.168736 * keyColor.r - 0.331264 * keyColor.g + 0.5 * keyColor.b;
        float Cr1 = 0.5 * keyColor.r - 0.418688 * keyColor.g - 0.081312 * keyColor.b;

        float Y2 = 0.299 * texColor.r + 0.587 * texColor.g + 0.114 * texColor.b;
        float Cb2 = -0.168736 * texColor.r - 0.331264 * texColor.g + 0.5 * texColor.b;
        float Cr2 = 0.5 * texColor.r - 0.418688 * texColor.g - 0.081312 * texColor.b;

        float dist = distance(vec2(Cb1, Cr1), vec2(Cb2, Cr2));
        if (dist < similarity) {
          discard;
        }
        float alpha = smoothstep(similarity, similarity + smoothness, dist);
        if (alpha < 0.05) discard;

        float maxRB = max(texColor.r, texColor.b);
        vec3 cleanRgb = texColor.rgb;
        if (cleanRgb.g > maxRB) {
          cleanRgb.g = maxRB + (cleanRgb.g - maxRB) * 0.2;
        }
        gl_FragColor = vec4(cleanRgb, texColor.a * alpha);
      } else if (keyMode == 5) {
        // Blue Screen Chroma Key with Blue Despill
        float Y1 = 0.299 * keyColor.r + 0.587 * keyColor.g + 0.114 * keyColor.b;
        float Cb1 = -0.168736 * keyColor.r - 0.331264 * keyColor.g + 0.5 * keyColor.b;
        float Cr1 = 0.5 * keyColor.r - 0.418688 * keyColor.g - 0.081312 * keyColor.b;

        float Y2 = 0.299 * texColor.r + 0.587 * texColor.g + 0.114 * texColor.b;
        float Cb2 = -0.168736 * texColor.r - 0.331264 * texColor.g + 0.5 * texColor.b;
        float Cr2 = 0.5 * texColor.r - 0.418688 * texColor.g - 0.081312 * texColor.b;

        float dist = distance(vec2(Cb1, Cr1), vec2(Cb2, Cr2));
        if (dist < similarity) {
          discard;
        }
        float alpha = smoothstep(similarity, similarity + smoothness, dist);
        if (alpha < 0.05) discard;

        float maxRG = max(texColor.r, texColor.g);
        vec3 cleanRgb = texColor.rgb;
        if (cleanRgb.b > maxRG) {
          cleanRgb.b = maxRG + (cleanRgb.b - maxRG) * 0.2;
        }
        gl_FragColor = vec4(cleanRgb, texColor.a * alpha);
      } else if (keyMode == 2) {
        // Black background removal (Luminance & Color Threshold key)
        float maxVal = max(texColor.r, max(texColor.g, texColor.b));
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float metric = max(luma, maxVal * 0.95);

        float threshold = similarity;
        float feather = smoothness;
        if (metric < threshold) {
          discard;
        }
        float alpha = smoothstep(threshold, threshold + feather, metric);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
      } else if (keyMode == 3) {
        // High-Precision Grey Screen Chroma Key (e.g. Composition_greybg.mp4)
        float maxC = max(texColor.r, max(texColor.g, texColor.b));
        float minC = min(texColor.r, min(texColor.g, texColor.b));
        float chroma = maxC - minC;

        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float targetLuma = dot(keyColor, vec3(0.299, 0.587, 0.114));
        float lumaDiff = abs(luma - targetLuma);
        float colorDist = distance(texColor.rgb, keyColor);

        // Robust thresholds for video compression artifacts & browser color spaces
        float chromaTol = 0.075;
        float lumaTol = max(similarity, 0.22);
        float distTol = max(similarity * 1.55, 0.28);

        if (chroma > chromaTol || lumaDiff > lumaTol || colorDist > distTol) {
          gl_FragColor = texColor;
        } else {
          float chromaFactor = smoothstep(0.02, chromaTol, chroma);
          float lumaFactor = smoothstep(lumaTol * 0.35, lumaTol, lumaDiff);
          float distFactor = smoothstep(distTol * 0.35, distTol, colorDist);
          float dancerStrength = max(chromaFactor, max(lumaFactor, distFactor));

          if (dancerStrength < 0.10) {
            discard;
          }

          float alpha = smoothstep(0.10, 0.70, dancerStrength);
          if (alpha < 0.02) discard;
          gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
        }
      } else if (keyMode == 4) {
        // White background removal
        float minVal = min(texColor.r, min(texColor.g, texColor.b));
        float luma = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
        float metric = 1.0 - min(luma, minVal);
        float threshold = similarity;
        float feather = smoothness;
        if (metric < threshold) {
          discard;
        }
        float alpha = smoothstep(threshold, threshold + feather, metric);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(texColor.rgb, texColor.a * alpha);
      } else {
        gl_FragColor = texColor;
      }
    }
  `
};

export function createBillboardMaterial(texture) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      keyMode: { value: arState.currentKeyMode },
      keyColor: { value: arState.currentKeyColor.clone() },
      similarity: { value: arState.currentSimilarity },
      smoothness: { value: arState.currentSmoothness }
    },
    vertexShader: ChromaShader.vertexShader,
    fragmentShader: ChromaShader.fragmentShader,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: false
  });
  material.forceSinglePass = true;
  return material;
}

export function applyKeySettings(mode, color = null, similarity = null, smoothness = null) {
  arState.currentKeyMode = mode;
  if (color) arState.currentKeyColor = color;
  if (similarity !== null) arState.currentSimilarity = similarity;
  if (smoothness !== null) arState.currentSmoothness = smoothness;

  const videoMesh = arState.videoMesh;
  if (videoMesh && videoMesh.material && videoMesh.material.uniforms) {
    if (videoMesh.material.uniforms.keyMode) {
      videoMesh.material.uniforms.keyMode.value = arState.currentKeyMode;
    }
    if (videoMesh.material.uniforms.keyColor && color) {
      videoMesh.material.uniforms.keyColor.value.copy(arState.currentKeyColor);
    }
    if (videoMesh.material.uniforms.similarity && similarity !== null) {
      videoMesh.material.uniforms.similarity.value = arState.currentSimilarity;
    }
    if (videoMesh.material.uniforms.smoothness && smoothness !== null) {
      videoMesh.material.uniforms.smoothness.value = arState.currentSmoothness;
    }
    videoMesh.material.needsUpdate = true;
  }
}

export function detectAndApplyKeyModeFromUrl(url) {
  if (!url) return;
  const decoded = decodeURIComponent(url).toLowerCase();
  arState.hasFilenameKeyTag = false;

  // 0. GIF, PNG, WebP, GLB have native alpha transparency (Do NOT chroma key them)
  if (/\.(gif|png|webp|glb|gltf)($|[?#])/i.test(decoded)) {
    console.log('Chroma Key: Asset has native alpha transparency. Mode 0 (Pass-through).');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(0);
    return;
  }

  // 1. Original / Opaque (No background removal)
  if (/(original|_original|originalbg|orig\b|_orig\b|_nobgkey|_opaque|_none\b|bg=none|key=none)/i.test(decoded)) {
    console.log('Chroma Key: Original / Opaque mode (No Background Removal)');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(0);
    return;
  }

  // 2. Grey / Gray background or MassKara video
  if (/(masskara|greybg|graybg|_greybg|_graybg|grey[_-]?bg|gray[_-]?bg|bg[_-]?grey|bg[_-]?gray|_grey\b|_gray\b)/i.test(decoded)) {
    console.log('Chroma Key: Detected Grey background from filename (greybg/masskara)');
    arState.hasFilenameKeyTag = true;
    // Exact grey color in Composition_greybg.mp4 is RGB(83, 83, 83)
    applyKeySettings(3, new THREE.Color(83 / 255, 83 / 255, 83 / 255), 0.22, 0.08);
    return;
  }

  // 3. Green background
  if (/(greenbg|_greenbg|green[_-]?bg|bg[_-]?green|_green\b|greenscreen|green-screen|green_screen|chroma[_-]?green|key[_-]?green)/i.test(decoded)) {
    console.log('Chroma Key: Detected Green Screen from filename (greenbg)');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(1, new THREE.Color(0x00ff00), 0.38, 0.10);
    return;
  }

  // 4. Blue background
  if (/(bluebg|_bluebg|blue[_-]?bg|bg[_-]?blue|_blue\b|bluescreen|blue-screen|blue_screen|chroma[_-]?blue|key[_-]?blue)/i.test(decoded)) {
    console.log('Chroma Key: Detected Blue Screen from filename (bluebg)');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(5, new THREE.Color(0x0000ff), 0.38, 0.10);
    return;
  }

  // 5. White background
  if (/(whitebg|_whitebg|white[_-]?bg|bg[_-]?white|_white\b)/i.test(decoded)) {
    console.log('Chroma Key: Detected White background from filename (whitebg)');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(4, new THREE.Color(1.0, 1.0, 1.0), 0.20, 0.12);
    return;
  }

  // 6. Black / nobg tag
  if (/(blackbg|_blackbg|black[_-]?bg|bg[_-]?black|_black\b|_nobg\b|nobg)/i.test(decoded)) {
    console.log('Chroma Key: Detected Black/NoBG from filename (blackbg)');
    arState.hasFilenameKeyTag = true;
    applyKeySettings(2, new THREE.Color(0x000000), 0.07, 0.14);
    return;
  }

  // Default fallback: Grey Screen keying (for MassKara dancer video)
  applyKeySettings(3, new THREE.Color(83 / 255, 83 / 255, 83 / 255), 0.22, 0.08);
}

export function autoDetectKeyModeFromVideo() {
  const dancerVideo = arState.dancerVideo;
  if (!dancerVideo || dancerVideo.videoWidth === 0) return;
  try {
    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 16;
    sampleCanvas.height = 16;
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(dancerVideo, 0, 0, 16, 16);
    const data = ctx.getImageData(0, 0, 16, 16).data;

    // Check corners: TL (0,0), TR (15,0), BL (0,15), BR (15,15)
    const corners = [0, 15 * 4, (15 * 16) * 4, (15 * 16 + 15) * 4];
    let totalR = 0, totalG = 0, totalB = 0;
    for (const idx of corners) {
      totalR += data[idx];
      totalG += data[idx + 1];
      totalB += data[idx + 2];
    }
    const avgR = totalR / 4;
    const avgG = totalG / 4;
    const avgB = totalB / 4;

    if (arState.hasFilenameKeyTag && arState.currentKeyMode === 3) {
      if (Math.abs(avgR - avgG) < 25 && Math.abs(avgG - avgB) < 25 && avgR > 30) {
        applyKeySettings(3, new THREE.Color(avgR / 255, avgG / 255, avgB / 255));
      }
      return;
    }

    if (arState.hasFilenameKeyTag) return;

    if (avgG > 80 && avgG > avgR * 1.35 && avgG > avgB * 1.35) {
      applyKeySettings(1, new THREE.Color(0x00ff00), 0.38, 0.10); // Green Screen
    } else if (avgB > 80 && avgB > avgR * 1.35 && avgB > avgG * 1.35) {
      applyKeySettings(5, new THREE.Color(0x0000ff), 0.38, 0.10); // Blue Screen
    } else if (Math.abs(avgR - avgG) < 20 && Math.abs(avgG - avgB) < 20 && avgR > 50 && avgR < 210) {
      applyKeySettings(3, new THREE.Color(avgR / 255, avgG / 255, avgB / 255), 0.18, 0.08); // Grey Screen
    } else if (avgR > 230 && avgG > 230 && avgB > 230) {
      applyKeySettings(4, new THREE.Color(1.0, 1.0, 1.0), 0.20, 0.12); // White Screen
    } else if (avgR < 40 && avgG < 40 && avgB < 40) {
      applyKeySettings(2, new THREE.Color(0x000000), 0.07, 0.14); // Black BG
    }
  } catch (err) {
    // Canvas read security restriction on cross-origin media
  }
}
