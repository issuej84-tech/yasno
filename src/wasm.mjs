export const INTEGER_TYPES = ['i32', 'u32', 'i64', 'u64'];
export const PRINT_TYPES = [...INTEGER_TYPES, 'bool', 'f64'];
export const MEMORY_LIMIT = 64 * 1024 * 1024;

export const OP = {
  unreachable: 0x00, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, brIf: 0x0d, return: 0x0f, call: 0x10, drop: 0x1a,
  get: 0x20, set: 0x21, tee: 0x22, globalGet: 0x23, globalSet: 0x24,
  load32: 0x28, load64: 0x29, loadF64: 0x2b, store32: 0x36, store64: 0x37, storeF64: 0x39,
  memorySize: 0x3f, memoryGrow: 0x40, i32: 0x41, i64: 0x42, f64: 0x44, eqz: 0x45,
  f64Neg: 0x9a, reinterpretF64: 0xbd,
  wrap: 0xa7, extendSigned: 0xac, extendUnsigned: 0xad,
};

export function unsigned(type) {
  return type.startsWith('u');
}

export function width(type) {
  return type === 'i64' || type === 'u64' || type === 'f64' ? 64 : 32;
}

export function valueType(type) {
  if (type === null) return 0x40;
  if (type === 'f64') return 0x7c;
  return width(type) === 64 ? 0x7e : 0x7f;
}

// Each entry lists the i32 opcode and, where applicable, the unsigned variant.
const comparisons = new Map([
  ['==', [0x46]], ['!=', [0x47]], ['<', [0x48, 0x49]], ['>', [0x4a, 0x4b]],
  ['<=', [0x4c, 0x4d]], ['>=', [0x4e, 0x4f]],
]);

const arithmetic = new Map([
  ['+', [0x6a]], ['-', [0x6b]], ['*', [0x6c]],
  ['/', [0x6d, 0x6e]], ['%', [0x6f, 0x70]],
  ['&', [0x71]], ['|', [0x72]], ['^', [0x73]],
  ['<<', [0x74]], ['>>', [0x75, 0x76]],
]);
const floatOperators = new Map([
  ['==', 0x61], ['!=', 0x62], ['<', 0x63], ['>', 0x64], ['<=', 0x65], ['>=', 0x66],
  ['+', 0xa0], ['-', 0xa1], ['*', 0xa2], ['/', 0xa3],
]);

export function floatOpcode(operator) {
  return floatOperators.get(operator);
}

export function isComparison(operator) {
  return comparisons.has(operator);
}

export function binaryOpcode(operator, type) {
  const table = isComparison(operator) ? comparisons : arithmetic;
  const [signedOpcode, unsignedOpcode = signedOpcode] = table.get(operator);
  const opcode = unsigned(type) ? unsignedOpcode : signedOpcode;
  if (width(type) === 32) return opcode;
  return opcode + (table === comparisons ? 11 : 18);
}

export function uleb(value) {
  const bytes = [];
  do {
    const low = value % 128;
    value = Math.floor(value / 128);
    bytes.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return bytes;
}

function sleb(value) {
  const bytes = [];
  while (true) {
    const low = Number(value & 0x7fn);
    value >>= 7n;
    const last = value === ((low & 0x40) === 0 ? 0n : -1n);
    bytes.push(last ? low : low | 0x80);
    if (last) return bytes;
  }
}

export function constant(type, value) {
  if (type === 'f64') {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return [OP.f64, ...bytes];
  }
  const bits = width(type);
  return [bits === 64 ? OP.i64 : OP.i32, ...sleb(BigInt.asIntN(bits, value))];
}

export function memoryOperation(type, store, offset = 0) {
  const alignment = width(type) === 64 ? 3 : 2;
  let opcode;
  if (type === 'f64') opcode = store ? OP.storeF64 : OP.loadF64;
  else if (alignment === 3) opcode = store ? OP.store64 : OP.load64;
  else opcode = store ? OP.store32 : OP.load32;
  return [opcode, alignment, ...uleb(offset)];
}

// Linear memory starts at address 8. Allocations are aligned and never overlap.
export function allocator() {
  const number = value => constant('i32', BigInt(value));
  const add = binaryOpcode('+', 'i32');
  return {
    params: ['i32'], result: 'i32', locals: ['i32', 'i32', 'i32'],
    code: [
      OP.globalGet, 0, OP.tee, 1, OP.get, 0, ...number(7), add,
      ...number(-8), binaryOpcode('&', 'i32'), add, OP.tee, 2,
      ...number(MEMORY_LIMIT), binaryOpcode('>', 'u32'),
      OP.if, 0x40, OP.unreachable, OP.end,
      OP.get, 2, ...number(65535), add, ...number(16), binaryOpcode('>>', 'u32'),
      OP.memorySize, 0, binaryOpcode('-', 'i32'), OP.tee, 3,
      ...number(0), binaryOpcode('>', 'i32'), OP.if, 0x40,
      OP.get, 3, OP.memoryGrow, 0, ...number(-1), binaryOpcode('==', 'i32'),
      OP.if, 0x40, OP.unreachable, OP.end, OP.end,
      OP.get, 2, OP.globalSet, 0, OP.get, 1,
    ],
  };
}

function vector(items) {
  return [...uleb(items.length), ...items.flat()];
}

function bytesWithLength(bytes) {
  return [...uleb(bytes.length), ...bytes];
}

function name(text) {
  return bytesWithLength(new TextEncoder().encode(text));
}

function section(id, entries) {
  if (entries.length === 0) return [];
  return [id, ...bytesWithLength(vector(entries))];
}

export function createModule(imports, functions, memory, shared) {
  const signatures = [];
  const typeIndices = new Map();

  function signature(params, result) {
    const inputs = params.map(valueType);
    const outputs = result === null ? [] : [valueType(result)];
    const key = JSON.stringify([inputs, outputs]);
    if (!typeIndices.has(key)) {
      typeIndices.set(key, signatures.length);
      signatures.push([0x60, ...uleb(inputs.length), ...inputs, ...uleb(outputs.length), ...outputs]);
    }
    return typeIndices.get(key);
  }

  const external = imports.map(fn => [
    ...name(fn.module), ...name(fn.field), 0x00, ...uleb(signature(fn.params, fn.result)),
  ]);
  const functionTypes = functions.map(fn => uleb(signature(fn.params, fn.result)));
  const exports = functions.filter(fn => fn.exportName != null).map(fn => [
    ...name(fn.exportName), 0x00, ...uleb(fn.index),
  ]);
  if (memory) exports.push([...name('memory'), 0x02, 0x00]);
  const bodies = functions.map(fn => {
    const groups = [];
    for (const type of fn.locals.map(valueType)) {
      const last = groups.at(-1);
      if (last?.type === type) last.count++;
      else groups.push({ type, count: 1 });
    }
    const declarations = vector(groups.map(({ count, type }) => [...uleb(count), type]));
    return bytesWithLength([...declarations, ...fn.code, OP.end]);
  });

  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    // A shared library with no static memory or table allocation.
    ...(shared ? [0, ...bytesWithLength([...name('dylink.0'), 1, ...bytesWithLength([0, 0, 0, 0])])] : []),
    ...section(1, signatures),
    ...section(2, external),
    ...section(3, functionTypes),
    ...section(5, memory ? [[0x01, 0x01, ...uleb(MEMORY_LIMIT / 65536)]] : []),
    ...section(6, memory ? [[valueType('i32'), 1, ...constant('i32', 8n), OP.end]] : []),
    ...section(7, exports),
    ...section(10, bodies),
  ]);
}
