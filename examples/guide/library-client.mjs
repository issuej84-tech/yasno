import { readFile } from 'node:fs/promises';

const libraryBytes = await readFile(new URL('energy.wasm', import.meta.url));
const clientBytes = await readFile(new URL('library-client.wasm', import.meta.url));
const library = await WebAssembly.instantiate(libraryBytes);
const client = await WebAssembly.instantiate(clientBytes, {
  env: library.instance.exports,
});
console.log(client.instance.exports.kilojoules(60, 20)); // 12
