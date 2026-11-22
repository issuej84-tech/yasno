import { readFile } from 'node:fs/promises';

const bytes = await readFile(new URL('scores.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, {
  // scores.ys also has a CLI entry point that uses print.
  yasno: { print: value => console.log(Number(value)) },
});
const { make_scores, sum, memory } = instance.exports;
const pointer = make_scores();
const view = new DataView(memory.buffer);
const length = view.getInt32(pointer, true);
const values = Array.from({ length }, (_, i) =>
  view.getInt32(pointer + 8 + i * 4, true),
);
console.log(values); // [ 10, 20, 30 ]
console.log(sum(pointer)); // 60
