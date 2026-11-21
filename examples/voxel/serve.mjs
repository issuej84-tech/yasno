import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { compile } from '../../src/compiler.mjs';

const read = name => readFileSync(new URL(name, import.meta.url));
const terrain = compile(read('terrain.ys').toString('utf8'));
const assets = new Map([
  ['/', ['text/html; charset=utf-8', read('index.html')]],
  ['/survey.css', ['text/css; charset=utf-8', read('survey.css')]],
  ['/survey.mjs', ['text/javascript; charset=utf-8', read('survey.mjs')]],
  ['/terrain.wasm', ['application/wasm', terrain]],
]);
const port = process.argv[2] === undefined ? 8080 : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Недопустимый порт.');

const server = createServer((request, response) => {
  const path = request.url.split('?')[0];
  const asset = assets.get(path);
  if (!asset || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  const [type, data] = asset;
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : data);
});
server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => console.log(`Кальдера · http://127.0.0.1:${server.address().port}/`));
