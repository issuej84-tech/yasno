import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRust, buildYasno, calculator, CalculatorError } from '../examples/calculator/runtime.mjs';

const subjects = [['Yasno', buildYasno]];
if (process.env.RUSTC) subjects.push(['Rust', buildRust]);

for (const [language, build] of subjects) {
  test(`${language} вычисляет выражения и проверяет ошибки`, () => {
    const evaluate = calculator(build());
    for (const [input, expected] of [
      ['2 + 3 * 4', 14],
      ['(2 + 3) * 4', 20],
      ['(12.5 - 2.5) * -3 + 8 / 2', -26],
      ['24 / 4 / 2', 3],
      ['12 - 5 - 3', 4],
      ['--(1. + .5)', 1.5],
      ['2 - -3', 5],
      ['\t.07 + 2 / 8\r\n', .07 + 2 / 8],
      ['-0', -0],
      ['('.repeat(64) + '2' + ')'.repeat(64), 2],
      ['+'.repeat(4095) + '9', 9],
    ]) {
      assert.equal(evaluate(input), expected);
    }
    const tiny = evaluate('0.' + '0'.repeat(310) + '1');
    assert(tiny > 0 && tiny < 1e-310);
    assert(Number.isFinite(evaluate('9'.repeat(308))));

    for (const [input, code, position] of [
      ['', 1, 0],
      ['2 +', 1, 3],
      ['.', 1, 0],
      ['(2 + 2', 2, 6],
      ['1 2', 3, 2],
      ['2 × 3', 3, 2],
      ['12/(2-2)', 4, 2],
      ['1 / -0.0', 4, 2],
      ['9'.repeat(400), 5, 0],
      ['9'.repeat(308) + '*2', 5, 308],
      ['('.repeat(65) + '2' + ')'.repeat(65), 6, 64],
      ['+'.repeat(4096) + '9', 7, 4096],
    ]) {
      assert.throws(() => evaluate(input), error =>
        error instanceof CalculatorError && error.code === code && error.position === position,
      );
    }
    assert.equal(evaluate('7 * 3'), 21);
  });
}
