import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/compiler.mjs';

const demo = new URL('../examples/voxel/', import.meta.url);
const output = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL('../docs/', import.meta.url));
const terrain = compile(await readFile(new URL('terrain.ys', demo), 'utf8'));
if (!WebAssembly.validate(terrain)) throw new Error('Сгенерирован некорректный файл terrain.wasm.');

await mkdir(output, { recursive: true });
await Promise.all([
  ...['index.html', 'survey.css', 'survey.mjs'].map(file => copyFile(new URL(file, demo), join(output, file))),
  writeFile(join(output, 'terrain.wasm'), terrain),
  writeFile(join(output, '.nojekyll'), ''),
]);
console.log(output);
