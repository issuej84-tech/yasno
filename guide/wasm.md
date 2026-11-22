# WebAssembly и JavaScript

[Документация Yasno](README.md)

Приложение загружает байты модуля, передаёт требуемые импорты и вызывает функции через `instance.exports`. Для библиотеки достаточно одного или нескольких `export fn`. Точку входа `main` используют программы для CLI. При ручной загрузке она вызывается как обычный экспорт.

## Вызов из браузера

Соберите пример со структурой корабля.

```sh
node yasno.mjs build examples/guide/ship.ys
```

Сохраните следующий файл как `examples/guide/index.html` рядом с `ship.wasm`.

```html
<!doctype html>
<meta charset="utf-8">
<title>Yasno в браузере</title>
<output id="speed"></output>
<script type="module">
  const output = document.querySelector('#speed');
  try {
    const response = await fetch('./ship.wasm');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {
      yasno: { print: (bits, code) => console.log({ bits, code }) },
    });
    output.textContent = String(instance.exports.simulate());
  } catch (error) {
    output.textContent = error.message;
  }
</script>
```

Раздайте папку по HTTP. Если установлен Python 3, из корня репозитория можно запустить `python -m http.server 8080 --bind 127.0.0.1 --directory examples/guide`. На Windows также можно вызвать `py -3` вместо `python`. При открытии страницы должно появиться `12.5`. Модуль требует импорт `yasno.print`, потому что его `main` использует печать. Вызов `simulate` сам по себе в консоль ничего не пишет. [Страница примера](http://127.0.0.1:8080/) · [ship.ys](../examples/guide/ship.ys)

Использование `arrayBuffer()` позволяет загрузить модуль независимо от MIME-типа ответа. Для `WebAssembly.instantiateStreaming` сервер должен отдавать файл как `application/wasm`.

## Импорты приложения

```text
extern "sim" "delta" fn read_delta() -> f64
extern "sim" "report" fn report(speed: f64)

export fn tick(speed: f64) -> f64 {
    let next = speed + read_delta()
    report(next)
    return next
}
```

Yasno вызывает `read_delta()`, а Wasm ищет функцию `delta` в модуле импортов `sim`. В Node.js можно передать такой объект через CLI. [host.ys](../examples/guide/host.ys) · [host.mjs](../examples/guide/host.mjs)

```js
export default {
  sim: {
    delta: () => 5.0,
    report: speed => console.log(speed),
  },
};
```

```sh
node yasno.mjs run examples/guide/host.ys --host examples/guide/host.mjs
```

Команда выводит `12.5`. При прямом вызове `WebAssembly.instantiate` передавайте объект `{ sim: { delta, report } }` вторым аргументом. Импорты вызываются синхронно, поэтому функция с результатом должна вернуть значение нужного типа в момент вызова. Даже объявленный и неиспользуемый `extern` требует соответствующую функцию при создании экземпляра.

## Типы на границе Wasm

| Yasno | Что передаёт и получает JavaScript |
| --- | --- |
| `i32` | `Number`, знаковое 32-битное целое |
| `u32` | `Number`. Интерпретируйте результат как беззнаковый через `value >>> 0` |
| `i64` | `BigInt`, например аргумент `42n` |
| `u64` | `BigInt`. Прочитайте результат через `BigInt.asUintN(64, value)` |
| `f64` | `Number` |
| `bool` | Передавайте `0` или `1`. Сравните результат с нулём для получения `boolean` |
| Массив или структура | `Number` с адресом в памяти экземпляра |
| Функция без результата | `undefined` |

Эти правила применяются к экспортам и импортам. Если модуль использует память Yasno, она доступна как `instance.exports.memory`. [Формат объектов в памяти](memory.md#формат-в-памяти-wasm)

## Печать при ручной загрузке

CLI предоставляет печать сам. При ручной загрузке программы, которая использует `print`, передайте импорт `yasno.print(raw, code)`. `raw` имеет тип JavaScript `BigInt`, а коды `0`–`5` соответствуют типам `i32`, `u32`, `i64`, `u64`, `bool`, `f64`.

```js
const scratch = new DataView(new ArrayBuffer(8));
const imports = {
  yasno: {
    print(raw, code) {
      if (code === 5) {
        scratch.setBigInt64(0, raw, true);
        console.log(scratch.getFloat64(0, true));
      } else if (code === 4) {
        console.log(raw !== 0n);
      } else {
        console.log((code === 3 ? BigInt.asUintN(64, raw) : raw).toString());
      }
    },
  },
};
```

Если программе нужны функции приложения, добавьте их в тот же объект `imports`. Имя `yasno.print` зарезервировано за встроенной функцией.

## Чтение массива из памяти

```sh
node yasno.mjs build examples/guide/scores.ys
node examples/guide/use-scores.mjs
```

Пример выводит `[ 10, 20, 30 ]` и затем `60`. `make_scores()` выдаёт адрес массива, JavaScript читает заголовок и три элемента, а `sum(pointer)` использует тот же массив внутри Wasm. [scores.ys](../examples/guide/scores.ys) · [use-scores.mjs](../examples/guide/use-scores.mjs)

## Связывание двух модулей

Режим `--shared` добавляет секцию `dylink.0` и ограничивает сигнатуры числовыми типами и `bool`. Такая библиотека собирается без линейной памяти и таблицы. Для сообщений объявите импорт приложения через `extern`. Встроенный `print` в этом режиме недоступен.

```sh
node yasno.mjs build examples/shared.ys --shared -o examples/guide/energy.wasm
node yasno.mjs build examples/guide/library-client.ys
node examples/guide/library-client.mjs
```

Программа выведет `12` килоджоулей для массы `60` и скорости `20`. Загрузчик создаёт экземпляр библиотеки и передаёт её экспорты клиенту как модуль `env`. Клиент объявляет `extern "env" "yasno_energy"`. Для интеграции с загрузчиком игры дополнительно понадобятся адаптер и правила ABI этого загрузчика. [Библиотека](../examples/shared.ys) · [Клиент](../examples/guide/library-client.ys) · [Загрузчик](../examples/guide/library-client.mjs)

## Компиляция в своём скрипте

Скрипт в корне репозитория может импортировать компилятор напрямую. `compile(source, { shared: true })` соответствует режиму `--shared`. По умолчанию собирается обычный модуль. Ошибки исходника приходят как `SourceError` с полями `token.line` и `token.column`, нумерация начинается с 1.

```js
import { compile } from './src/compiler.mjs';

const bytes = compile('export fn square(n: i32) -> i32 { return n * n }');
const { instance } = await WebAssembly.instantiate(bytes);
console.log(instance.exports.square(7)); // 49
```
