import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compile } from '../src/compiler.mjs';
import { SourceError } from '../src/syntax.mjs';

function instantiate(source, imports = {}, options = {}) {
  const bytes = compile(source, options);
  const module = new WebAssembly.Module(bytes);
  return { module, exports: new WebAssembly.Instance(module, imports).exports };
}

test('вложенные массивы и структуры передаются по ссылке', () => {
  const { exports } = instantiate(`
    struct Point { x: f64, y: i64 }
    struct Group { points: [[Point]] }
    fn first(group: Group) -> Point { return group.points[0][0] }

    export fn make() -> Group {
      let rows = new [[Point]](1)
      rows[0] = new [Point](2)
      let group = Group(rows)
      group.points[0][0] = Point(1.5e1, -3i64)
      let point = first(group)
      point.x = -point.x / 2.0
      return group
    }

    export fn position(group: Group) -> f64 { return first(group).x + f64(first(group).y) }
    export fn uninitialized(group: Group) -> f64 { return group.points[0][1].x }
  `);
  const group = exports.make();
  assert.equal(exports.position(group), -10.5);
  assert.throws(() => exports.uninitialized(group), WebAssembly.RuntimeError);
});

test('выход за границы не затрагивает соседний массив', () => {
  const { exports } = instantiate(`
    export fn make(length: i32) -> [i64] { return new [i64](length) }
    export fn get(data: [i64], index: i32) -> i64 { return data[index] }
    export fn set(data: [i64], index: i32, value: i64) { data[index] = value }
    export fn length(data: [i64]) -> i32 { return data.length }
  `);
  const first = exports.make(2);
  const second = exports.make(40_000);
  assert(exports.memory.buffer.byteLength >= 320_000);
  assert.equal(exports.length(second), 40_000);
  exports.set(second, 0, 990n);
  assert.throws(() => exports.set(first, 3, 777n), WebAssembly.RuntimeError);
  assert.throws(() => exports.get(first, -1), WebAssembly.RuntimeError);
  assert.equal(exports.get(second, 0), 990n);
  assert.equal(exports.get(second, 39_999), 0n);
  assert.throws(() => exports.get(exports.make(0), 0), WebAssembly.RuntimeError);
  assert.throws(() => exports.make(2_147_483_647), WebAssembly.RuntimeError);
  assert.throws(() => exports.make(-1), WebAssembly.RuntimeError);
});

test('имя экспорта и скалярные импорты работают между модулями', () => {
  const producer = readFileSync(new URL('../examples/shared.ys', import.meta.url), 'utf8');
  const library = instantiate(producer, {}, { shared: true });
  assert.deepEqual(WebAssembly.Module.imports(library.module), []);
  const [dylink] = WebAssembly.Module.customSections(library.module, 'dylink.0');
  assert.deepEqual([...new Uint8Array(dylink)], [1, 4, 0, 0, 0, 0]);
  assert.equal(Reflect.has(library.exports, 'memory'), false);
  const { exports } = instantiate(`
    extern "env" "yasno_energy" fn energy(mass: f64, velocity: f64) -> f64
    export "in-kilojoules" fn run(mass: i32, speed: i32) -> f64 {
      return energy(f64(mass), f64(speed)) / 1000.0
    }
  `, { env: library.exports });
  assert.equal(exports['in-kilojoules'](60, 20), 12);
});

test('неверные обращения к памяти отклоняются при компиляции', () => {
  for (const [source, message, shared] of [
    ['fn f(a: [i32]) { a.length = 2 }', /Длину массива/],
    ['fn f(a: [i32]) { a[0u32] = 2 }', /тип i32/],
    ['fn f(a: [i32]) { a[0] = 2.0 }', /тип i32/],
    ['struct Point { x: f64, x: f64 }', /уже объявлено/],
    ['fn f(x: f64) -> f64 { return x % 2.0 }', /не поддерживает/],
    ['export "memory" fn f() { let a = new [i32](1) }', /занято линейной памятью/],
    ['export fn a() { let a = new [i32](12) }', /не поддерживает массивы/, true],
    ['export fn a() { print(12) }', /extern/, true],
    ['extern "yasno" "print" fn a() ', /закреплён/],
  ]) {
    assert.throws(() => compile(source, { shared }), error => error instanceof SourceError && message.test(error.message));
  }
});

test('оптимизация сохраняет проверки ссылок и порядок вычислений', () => {
  const checks = [];
  const { exports } = instantiate(`
    struct Cell { value: i32 }
    extern "host" "keep" fn keep(index: i32) -> bool

    export fn walk() -> i32 {
      var index = 0
      var result = 0
      while keep(index) {
        index = index + 1
        if index == 2 { continue }
        if index == 4 { break }
        result = result + index
      }
      return result
    }

    export fn optional(data: [i32], enabled: bool) -> bool {
      return enabled && data[0] == 1
    }

    export fn read(flag: bool) -> i32 {
      let cells = new [Cell](1)
      let cell = cells[0]
      if flag { return cell.value }
      return cell.value
    }
  `, { host: { keep(index) { checks.push(index); return index < 7 ? 1 : 0; } } });
  assert.equal(exports.walk(), 4);
  assert.deepEqual(checks, [0, 1, 2, 3]);
  assert.equal(exports.optional(0, 0), 0);
  assert.throws(() => exports.optional(0, 1), WebAssembly.RuntimeError);
  assert.throws(() => exports.read(0), WebAssembly.RuntimeError);
  assert.throws(() => exports.read(1), WebAssembly.RuntimeError);
});

test('воксельный пример генерирует грани и повторно использует память', () => {
  const notices = [];
  const source = readFileSync(new URL('../examples/voxel/terrain.ys', import.meta.url), 'utf8');
  const { exports } = instantiate(source, { terrain: { changed: count => notices.push(count) } });
  const world = exports.create();
  const before = exports.memory.buffer;
  exports.generate(world, 408);
  const count = exports.rebuild(world);
  assert(count > 500);
  assert.equal(notices.at(-1), count);
  const offset = exports.faces(world) + 8;
  const original = Int32Array.from(new Int32Array(before, offset, count * 5));
  const directions = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
  const found = new Set();
  for (let i = 0; i < original.length; i += 5) {
    const [x, y, z, side, material] = original.subarray(i, i + 5);
    const [dx, dy, dz] = directions[side];
    assert.equal(exports.block_at(world, x, y, z), material);
    assert.equal(exports.block_at(world, x + dx, y + dy, z + dz), 0);
    found.add(`${x},${y},${z},${side}`);
  }
  assert.equal(found.size, count);
  const [x, y, z] = original;
  assert.equal(exports.set_block(world, -1, y, z, 0), 0);
  assert.equal(exports.set_block(world, x, y, z, 0), 1);
  assert.equal(exports.block_at(world, x, y, z), 0);
  exports.rebuild(world);
  assert.equal(notices.length, 2);
  exports.generate(world, 408);
  assert.equal(exports.rebuild(world), count);
  assert.equal(exports.memory.buffer, before);
  assert.deepEqual(new Int32Array(before, offset, count * 5), original);
});
