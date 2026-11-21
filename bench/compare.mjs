import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rustc = process.argv[2] ?? 'rustc';
const root = fileURLToPath(new URL('../', import.meta.url));
const benchDir = fileURLToPath(new URL('./', import.meta.url));
const tests = [
  { name: 'count_primes', args: [1_000_000], expected: 78_498 },
  { name: 'checksum', args: [36_000_000, 123_456_789] },
];

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${executable} завершился с кодом ${result.status}.`);
  return result.stdout.trim();
}

function elapsed(operation) {
  const start = performance.now();
  const result = operation();
  return { ms: performance.now() - start, result };
}

function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(2);
}

function orders(runs, operation) {
  for (let i = 0; i < runs; i++) {
    operation(i % 2);
    operation(1 - (i % 2));
  }
}

function benchmark(directory) {
  const yasno = join(directory, 'yasno.wasm');
  const rust = join(directory, 'rust.wasm');
  const builds = [
    () => run(process.execPath, [join(root, 'yasno.mjs'), 'build', join(benchDir, 'kernels.ys'), '-o', yasno]),
    () => run(rustc, [
      join(benchDir, 'kernels.rs'), '--edition=2021', '--crate-type=cdylib',
      '--target=wasm32-unknown-unknown', '-O', '-C', 'panic=abort',
      '-C', 'link-arg=--strip-all', '-o', rust,
    ]),
  ];
  const rustVersion = run(rustc, ['--version']);
  const buildTimes = [[], []];
  orders(1, index => builds[index]());
  orders(7, index => buildTimes[index].push(elapsed(builds[index]).ms));

  const imports = { yasno: { print() { throw new Error('В замере не должно быть вывода.'); } } };
  const binaries = [yasno, rust].map(file => readFileSync(file));
  const exports = binaries.map(bytes => new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports);
  const results = [];

  for (const { name, args, expected } of tests) {
    const functions = exports.map(module => module[name]);
    let reference = expected;
    const samples = [[], []];
    const measure = index => {
      const { ms, result } = elapsed(() => functions[index](...args));
      reference ??= result;
      if (result !== reference) throw new Error(`${name} вернула ${result} вместо ${reference}.`);
      return ms;
    };
    orders(3, measure);
    orders(11, index => samples[index].push(measure(index)));
    results.push({ 'Измерение': `${name}(${args.join(', ')}) · мс`, 'Yasno': median(samples[0]), 'Rust': median(samples[1]) });
  }

  console.log(`${cpus()[0].model} · ${process.platform}/${process.arch} · Node.js ${process.version} · ${rustVersion}`);
  console.table([
    ...results,
    { 'Измерение': 'Сборка с запуском процесса · мс', 'Yasno': median(buildTimes[0]), 'Rust': median(buildTimes[1]) },
    { 'Измерение': 'Размер модуля · байты', 'Yasno': binaries[0].length, 'Rust': binaries[1].length },
  ]);
}

const directory = mkdtempSync(join(tmpdir(), 'yasno-bench-'));
try {
  benchmark(directory);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const file of ['yasno.wasm', 'rust.wasm']) rmSync(join(directory, file), { force: true });
  rmdirSync(directory);
}
