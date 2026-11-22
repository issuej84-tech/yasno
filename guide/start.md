# Быстрый старт

[Документация Yasno](README.md)

## Подготовка

Установите Node.js. Команды проверены с Node.js 26.13.0. Для скачивания через терминал нужен Git. Если вы скачали ZIP-архив исходников с GitHub, распакуйте его и откройте терминал в папке с `yasno.mjs`.

```sh
git clone https://github.com/issuej84-tech/yasno.git
cd yasno
node --version
node yasno.mjs --help
```

Компилятор использует стандартную библиотеку Node.js. После скачивания можно сразу запускать команды.

## Первая программа

Создайте файл `hello.ys` в корне проекта и сохраните его в UTF-8. Этот исходник также лежит в репозитории. [hello.ys](../examples/guide/hello.ys)

```text
fn main() {
    var total = 0
    for n in 1 .. 11 {
        total = total + n
    }
    print(total)
}
```

```sh
node yasno.mjs run hello.ys
```

Результат — `55`. Тип `total` выводится из литерала `0`, поэтому это `i32`. Переменная объявлена через `var`, чтобы обновлять её внутри цикла. Цикл перебирает числа от 1 до 10, а `print` передаёт результат в консоль.

Для запуска исходника из репозитория используйте `node yasno.mjs run examples/guide/hello.ys`.

## Проверка и сборка

```sh
node yasno.mjs check hello.ys
node yasno.mjs build hello.ys -o hello.wasm
node yasno.mjs run hello.wasm
```

`check` компилирует исходник и проверяет Wasm-модуль без запуска. `build` записывает бинарный файл. Последняя команда вызовет ту же `main` и снова выведет `55`. [Команды и диагностика](cli.md)

## Структура как состояние

Следующая программа создаёт корабль со скоростью `7.5`, передаёт его в функцию и увеличивает скорость на `5.0`. [ship.ys](../examples/guide/ship.ys)

```text
struct Ship { speed: f64 }

fn boost(ship: Ship, delta: f64) {
    ship.speed = ship.speed + delta
}

export fn simulate() -> f64 {
    let ship = Ship(7.5)
    boost(ship, 5.0)
    return ship.speed
}

fn main() {
    print(simulate())
}
```

```sh
node yasno.mjs run examples/guide/ship.ys
```

Результат — `12.5`. `let ship` закрепляет ссылку на структуру за переменной, а функция `boost` меняет поле по этой ссылке. Благодаря `export` приложение также может вызвать `simulate()` напрямую. [Массивы, структуры и память](memory.md) · [Вызов из браузера](wasm.md#вызов-из-браузера)
