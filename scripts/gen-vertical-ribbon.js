import fs from 'fs';

const src = fs.readFileSync('public/bacolod-mosaic-ribbon.svg', 'utf8');

// ViewBox 0 0 30 360 (width 30, height 360)
const defsMatch = src.match(/<defs>[\s\S]*?<\/defs>/);
const defs = defsMatch ? defsMatch[0] : '';
const bodyStart = src.indexOf('</defs>') + 7;
const bodyEnd = src.lastIndexOf('</svg>');
const body = src.substring(bodyStart, bodyEnd);

// Split tiles by comment headers
const tiles = body.split(/(?=<!-- ── \d+\.)/).filter(t => t.trim());
console.log('Found tiles:', tiles.length);

let verticalBody = '';
tiles.forEach((tile, i) => {
  const shiftX = -i * 30;
  const shiftY = i * 30;
  verticalBody += `  <!-- Tile ${i} (Upright in vertical strip) -->\n  <g transform="translate(${shiftX}, ${shiftY})">\n${tile.trim()}\n  </g>\n\n`;
});

const vertSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 360" width="30" height="360">
  ${defs}
${verticalBody}</svg>\n`;

fs.writeFileSync('public/bacolod-mosaic-ribbon-vertical.svg', vertSvg, 'utf8');
console.log('Upright vertical ribbon generated successfully!');
