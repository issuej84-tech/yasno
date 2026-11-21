const canvas = document.querySelector('#map');
const context = canvas.getContext('2d');
const seedForm = document.querySelector('#seed-form');
const seedInput = document.querySelector('#seed');
const faceCount = document.querySelector('#face-count');
const status = document.querySelector('#status');
const materials = document.querySelector('#materials');
const remove = document.querySelector('#remove');
const place = document.querySelector('#place');
const turnLeft = document.querySelector('#rotate-left');
const turnRight = document.querySelector('#rotate-right');
const saveKey = 'yasno-caldera-v1';

// Each face describes the delta for a new block and its four corners.
const sides = [
  { normal: [0, 1, 0], corners: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] },
  { normal: [1, 0, 0], corners: [[1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 1, 0]] },
  { normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1]] },
  { normal: [0, 0, 1], corners: [[1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] },
];
const colors = [
  null,
  ['#7c9090', '#59676c', '#444f59'],
  ['#83b3a5', '#558b86', '#3b6768'],
  ['#dab078', '#aa7652', '#835c48'],
  ['#d7fcf3', '#8dccbf', '#679ea4'],
];
const edits = new Map();
let api;
let world;
let seed = 408;
let turn = 0;
let mode = 'remove';
let count = 0;
let faces = [];
let selected = null;

function orient(x, z) {
  switch (turn) {
    case 1: return [-z, x];
    case 2: return [-x, -z];
    case 3: return [z, -x];
    default: return [x, z];
  }
}

function refresh() {
  if (!api) return;
  const { width, height } = canvas.getBoundingClientRect();
  if (!width || !height) return;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

  const unit = Math.min((width - 36) / 42, (height - 54) / 32);
  const center = [width / 2, height / 2 + 2.4 * unit];
  const project = (x, y, z) => {
    const [u, v] = orient(x - 12, z - 12);
    return [center[0] + (u - v) * unit * .866, center[1] + ((u + v) * .43 - y * .87) * unit];
  };

  const pointer = api.faces(world);
  const data = new Int32Array(api.memory.buffer, pointer + 8, count * 5);
  faces = [];
  for (let i = 0; i < data.length; i += 5) {
    const x = data[i];
    const y = data[i + 1];
    const z = data[i + 2];
    const side = data[i + 3];
    const surface = sides[side];
    if (!surface) continue;
    const [nx, ny, nz] = surface.normal;
    const [nu, nv] = orient(nx, nz);
    if (ny === 0 && nu + nv < 0) continue;

    const [u, v] = orient(x + .5 + nx / 2, z + .5 + nz / 2);
    faces.push({
      x, y, z, normal: surface.normal,
      depth: u + v + (y + .5 + ny / 2) * .9885,
      color: colors[data[i + 4]][ny ? 0 : nu ? 1 : 2],
      polygon: surface.corners.map(([dx, dy, dz]) => project(x + dx, y + dy, z + dz)),
    });
  }
  faces.sort((a, b) => a.depth - b.depth);
  selected = null;
  paint();
}

function path(polygon) {
  context.beginPath();
  context.moveTo(...polygon[0]);
  for (const point of polygon.slice(1)) context.lineTo(...point);
  context.closePath();
}

function paint() {
  const { width, height } = canvas.getBoundingClientRect();
  context.clearRect(0, 0, width, height);
  context.lineWidth = .6;
  context.lineJoin = 'round';
  context.strokeStyle = '#25303280';
  for (const { color, polygon } of faces) {
    path(polygon);
    context.fillStyle = color;
    context.fill();
    context.stroke();
  }
  if (selected) {
    path(selected.polygon);
    context.fillStyle = mode === 'remove' ? '#2018235c' : '#f7db9c80';
    context.fill();
    context.strokeStyle = '#fff5d6';
    context.lineWidth = 1.3;
    context.stroke();
  }
}

function contains(polygon, x, y) {
  let positive = false;
  let negative = false;
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    positive ||= cross > 0;
    negative ||= cross < 0;
    if (positive && negative) return false;
  }
  return true;
}

function findFace(event) {
  const { left, top } = canvas.getBoundingClientRect();
  const x = event.clientX - left;
  const y = event.clientY - top;
  return faces.findLast(face => contains(face.polygon, x, y)) ?? null;
}

function save(message) {
  try {
    localStorage.setItem(saveKey, JSON.stringify({ seed, edits: [...edits.values()] }));
    status.textContent = message;
  } catch {
    status.textContent = 'Хранилище браузера недоступно.';
  }
}

function load() {
  try {
    const previous = JSON.parse(localStorage.getItem(saveKey));
    if (previous && Number.isInteger(previous.seed) && (previous.seed | 0) === previous.seed) {
      return previous;
    }
  } catch {
    return null;
  }
  return null;
}

function generate(previous = []) {
  edits.clear();
  api.generate(world, seed);
  for (const edit of previous) {
    if (!Array.isArray(edit) || edit.length !== 4 || !edit.every(value => (value | 0) === value)) continue;
    const [x, y, z, material] = edit;
    if (api.set_block(world, x, y, z, material)) edits.set(`${x},${y},${z}`, edit);
  }
  api.rebuild(world);
  refresh();
}

function setMode(next) {
  mode = next;
  remove.setAttribute('aria-pressed', String(mode === 'remove'));
  place.setAttribute('aria-pressed', String(mode === 'place'));
  paint();
}

function rotate(delta) {
  turn = (turn + delta + 4) % 4;
  refresh();
}

canvas.addEventListener('pointermove', event => {
  const face = findFace(event);
  if (selected !== face) {
    selected = face;
    paint();
  }
});
canvas.addEventListener('pointerleave', () => {
  if (selected) {
    selected = null;
    paint();
  }
});
canvas.addEventListener('click', event => {
  const face = findFace(event);
  if (!face) return;
  let { x, y, z } = face;
  let material = 0;
  if (mode === 'place') {
    const [dx, dy, dz] = face.normal;
    x += dx;
    y += dy;
    z += dz;
    material = Number(materials.querySelector('input:checked').value);
  }
  if (!api.set_block(world, x, y, z, material)) {
    status.textContent = 'Здесь блок изменить нельзя.';
    return;
  }
  edits.set(`${x},${y},${z}`, [x, y, z, material]);
  api.rebuild(world);
  refresh();
  save('Правка сохранена.');
});

seedForm.addEventListener('submit', event => {
  event.preventDefault();
  const next = seedInput.valueAsNumber;
  if (!Number.isInteger(next) || (next | 0) !== next) return;
  seed = next;
  generate();
  save('Карта создана и сохранена.');
});
turnLeft.addEventListener('click', () => rotate(-1));
turnRight.addEventListener('click', () => rotate(1));
remove.addEventListener('click', () => setMode('remove'));
place.addEventListener('click', () => setMode('place'));

try {
  if (!context) throw new Error('Canvas недоступен.');
  const response = await fetch(new URL('./terrain.wasm', import.meta.url));
  if (!response.ok) throw new Error(`Не удалось загрузить terrain.wasm (${response.status}).`);
  const runtime = await WebAssembly.instantiate(await response.arrayBuffer(), {
    terrain: {
      changed(total) {
        count = total;
        faceCount.textContent = total.toLocaleString('ru-RU');
      },
    },
  });
  api = runtime.instance.exports;
  world = api.create();
  const previous = load();
  if (previous) seed = previous.seed;
  seedInput.value = String(seed);
  generate(Array.isArray(previous?.edits) ? previous.edits : []);
  new ResizeObserver(refresh).observe(canvas);
  for (const control of [seedInput, document.querySelector('#generate'), materials, remove, place, turnLeft, turnRight]) {
    control.disabled = false;
  }
  status.textContent = previous ? 'Карта восстановлена.' : 'Щёлкните по грани блока, чтобы изменить карту.';
} catch (error) {
  status.textContent = `Карта не загрузилась. ${error.message}`;
}
