import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../../src/compiler.mjs';

const messages = [
  '',
  'Ожидалось число или «(».',
  'Ожидалась «)».',
  'Лишний символ после выражения.',
  'Деление на ноль.',
  'Число выходит за диапазон f64.',
  'Слишком много вложенных скобок.',
  'Выражение слишком длинное.',
];

export function buildYasno() {
  return compile(readFileSync(new URL('calculator.ys', import.meta.url), 'utf8'));
}

export function buildRust(rustc = process.env.RUSTC || 'rustc') {
  const directory = mkdtempSync(join(tmpdir(), 'yasno-calculator-'));
  const output = join(directory, 'calculator.wasm');
  try {
    const source = fileURLToPath(new URL('calculator.rs', import.meta.url));
    const build = spawnSync(rustc, [
      source, '--edition=2021', '--crate-type=cdylib', '--target=wasm32-unknown-unknown',
      '-O', '-C', 'panic=abort', '-C', 'link-arg=--strip-all', '-o', output,
    ], { encoding: 'utf8', windowsHide: true });
    if (build.error?.code === 'ENOENT') throw new Error('Не найден rustc. Укажите путь в переменной RUSTC.');
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(build.stderr.trim() || 'Сборка Rust завершилась с ошибкой.');
    return readFileSync(output);
  } finally {
    rmSync(output, { force: true });
    rmdirSync(directory);
  }
}

export class CalculatorError extends Error {
  constructor(code, position, capacity) {
    const message = code === 7 ? `Максимальная длина выражения — ${capacity} символов.` : messages[code];
    super(message);
    this.code = code;
    this.position = position;
  }
}

export function calculator(bytes) {
  const { exports: engine } = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const state = engine.create();
  const start = engine.input_buffer(state);
  const view = new DataView(engine.memory.buffer);
  const capacity = engine.input_capacity ? engine.input_capacity(state) : view.getInt32(start, true);

  return function evaluate(expression) {
    if (expression.length > capacity) throw new CalculatorError(7, capacity, capacity);
    for (let i = 0; i < expression.length; i++) {
      view.setInt32(start + 8 + i * 4, expression.charCodeAt(i), true);
    }
    const result = engine.evaluate(state, expression.length);
    const code = engine.error_code(state);
    if (code !== 0) throw new CalculatorError(code, engine.error_position(state), capacity);
    return result;
  };
}
