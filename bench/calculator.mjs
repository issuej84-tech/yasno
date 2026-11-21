import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { buildRust, buildYasno, calculator } from '../examples/calculator/runtime.mjs';

function median(samples) {
  return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
}

function measure(operation, rounds) {
  const samples = [[], []];
  for (let round = 0; round < rounds; round++) {
    for (const index of [round % 2, 1 - round % 2]) {
      const start = performance.now();
      operation(index);
      samples[index].push(performance.now() - start);
    }
  }
  return samples.map(values => median(values).toFixed(2));
}

function shortExpressions() {
  return Array.from({ length: 128 }, (_, i) => {
    const n = i % 13;
    const divisor = [2, 4, 8][i % 3];
    const input = `(${i}.5 - ${n}.25) * -3 + ${i + 1} / ${divisor}`;
    return { input, expected: ((i + 0.5) - (n + 0.25)) * -3 + (i + 1) / divisor };
  });
}

function longExpressions(short) {
  return short.map((_, start) => {
    const terms = Array.from({ length: 16 }, (_, i) => short[(start + i * 7) % short.length]);
    return {
      input: terms.map(term => `(${term.input})`).join(' + '),
      expected: terms.slice(1).reduce((total, term) => total + term.expected, terms[0].expected),
    };
  });
}

function benchmark(rustc) {
  const build = [buildYasno, () => buildRust(rustc)];
  const binaries = build.map(load => load());
  const evaluate = binaries.map(calculator);
  const short = shortExpressions();
  const workloads = [
    { label: 'Короткие выражения', corpus: short, repetitions: 100_000 },
    { label: 'Длинные выражения', corpus: longExpressions(short), repetitions: 10_000 },
  ];
  const rows = [];
  for (const { label, corpus, repetitions } of workloads) {
    for (const { input, expected } of corpus) {
      for (const solve of evaluate) assert.equal(solve(input), expected, input);
    }
    const expected = Array.from({ length: repetitions }, (_, i) => corpus[i % corpus.length].expected)
      .reduce((sum, value) => sum + value, 0);

    function batch(index) {
      const solve = evaluate[index];
      let total = 0;
      for (let i = 0; i < repetitions; i++) total += solve(corpus[i % corpus.length].input);
      assert.equal(total, expected);
    }

    measure(batch, 3);
    const [yasno, rust] = measure(batch, 11);
    rows.push({ 'Измерение': label, 'Вычислений': repetitions, 'Yasno': `${yasno} мс`, 'Rust': `${rust} мс` });
  }
  rows.push({ 'Измерение': 'Размер Wasm', 'Вычислений': '—', 'Yasno': `${binaries[0].byteLength} Б`, 'Rust': `${binaries[1].byteLength} Б` });
  console.log(`${cpus()[0].model.trim()} · ${process.platform}/${process.arch} · Node.js ${process.version}`);
  console.table(rows);
}

try {
  benchmark(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
