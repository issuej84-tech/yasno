import { createInterface } from 'node:readline';
import { buildRust, buildYasno, calculator, CalculatorError } from './runtime.mjs';

function show(evaluate, expression) {
  try {
    console.log(evaluate(expression));
    return true;
  } catch (error) {
    if (!(error instanceof CalculatorError)) throw error;
    console.error(`Ошибка в позиции ${error.position + 1}. ${error.message}`);
    if (expression.length <= 120 && !expression.includes('\n') && !expression.includes('\r')) {
      console.error(expression);
      console.error(expression.slice(0, error.position).replace(/[^\t]/g, ' ') + '^');
    }
    return false;
  }
}

async function main(args) {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log('node examples/calculator/run.mjs [--rust] ["выражение"]');
    console.log('Операции +, -, *, /, круглые скобки и дроби с точкой. Без аргументов — ввод по строкам.');
    return;
  }
  const rust = args[0] === '--rust';
  if (rust) args.shift();
  if (args[0] === '--') args.shift();
  const evaluate = calculator(rust ? buildRust() : buildYasno());
  if (args.length > 0) {
    if (!show(evaluate, args.join(' '))) process.exitCode = 1;
    return;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const readline = createInterface({
    input: process.stdin,
    output: interactive ? process.stdout : undefined,
    terminal: interactive,
    prompt: 'выражение> ',
    crlfDelay: Infinity,
  });
  readline.prompt();
  for await (const line of readline) {
    if (line.trim() === '.exit') break;
    if (line.trim() && !show(evaluate, line) && !interactive) process.exitCode = 1;
    readline.prompt();
  }
  readline.close();
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
