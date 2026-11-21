import { readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from './src/compiler.mjs';
import { SourceError } from './src/syntax.mjs';
import { PRINT_TYPES } from './src/wasm.mjs';

const usage = `Yasno
  node yasno.mjs run <файл.ys|файл.wasm> [--host <модуль.mjs>]
  node yasno.mjs build <файл.ys> [--shared] [-o <файл.wasm>]
  node yasno.mjs check <файл.ys>`;

function hostPrint(value, code) {
  const type = PRINT_TYPES[code];
  if (type === 'bool') console.log(value === 0n ? 'false' : 'true');
  else if (type === 'f64') {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setBigInt64(0, value, true);
    console.log(bits.getFloat64(0, true));
  } else {
    console.log((type === 'u64' ? BigInt.asUintN(64, value) : value).toString());
  }
}

function sourceDiagnostic(file, source, error) {
  const { line, column } = error.token;
  const text = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)[line - 1];
  const padding = text.slice(0, column - 1).replace(/[^\t]/g, ' ');
  return `${file}:${line}:${column}: ${error.message}\n${text}\n${padding}^`;
}

async function main(args) {
  const [command, file, ...options] = args;
  if (args.length === 0 || command === '--help' || command === '-h') {
    console.log(usage);
    return;
  }
  const isBuild = command === 'build';
  const isRun = command === 'run';
  const isCheck = command === 'check';
  const sourceFile = Boolean(file) && extname(file).toLowerCase() === '.ys';
  const wasmFile = Boolean(file) && extname(file).toLowerCase() === '.wasm';
  if (!(isRun || isBuild || isCheck) || !(sourceFile || (isRun && wasmFile))) {
    throw new Error(usage);
  }
  let output;
  let hostFile;
  let shared = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    const value = options[i + 1];
    if (isBuild && option === '--shared' && !shared) {
      shared = true;
    } else if (isBuild && option === '-o' && !output && value && extname(value).toLowerCase() === '.wasm') {
      output = value;
      i++;
    } else if (isRun && option === '--host' && !hostFile && value && !value.startsWith('--')) {
      hostFile = value;
      i++;
    } else {
      throw new Error(usage);
    }
  }

  let bytes;
  if (sourceFile) {
    const source = readFileSync(file, 'utf8');
    try {
      bytes = compile(source, { shared });
    } catch (error) {
      if (error instanceof SourceError) throw new Error(sourceDiagnostic(file, source, error));
      throw error;
    }
  } else {
    bytes = readFileSync(file);
  }

  if (isBuild) {
    writeFileSync(output ?? `${file.slice(0, -extname(file).length)}.wasm`, bytes);
  } else if (isRun) {
    const provided = hostFile ? (await import(pathToFileURL(resolve(hostFile)).href)).default : {};
    if (!provided || typeof provided !== 'object') {
      throw new Error('Модуль --host должен экспортировать объект импортов через export default.');
    }
    const imports = Object.assign(Object.create(null), provided);
    imports.yasno = { ...provided.yasno, print: hostPrint };
    const module = new WebAssembly.Module(bytes);
    for (const entry of WebAssembly.Module.imports(module)) {
      if (typeof imports[entry.module]?.[entry.name] !== 'function') {
        throw new Error(`Не найдена функция приложения «${entry.module}.${entry.name}». Передайте модуль через --host.`);
      }
    }
    const instance = new WebAssembly.Instance(module, imports);
    if (typeof instance.exports.main !== 'function') {
      throw new Error('Точка входа отсутствует. Добавьте fn main() { … }.');
    }
    instance.exports.main();
  } else {
    if (!WebAssembly.validate(bytes)) throw new Error('Компилятор создал некорректный WebAssembly.');
    console.log('Проверка пройдена.');
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof WebAssembly.RuntimeError ? `Ошибка выполнения: ${error.message}` : error.message);
  process.exitCode = 1;
}
