import { parse, SourceError } from './syntax.mjs';
import {
  INTEGER_TYPES, PRINT_TYPES, MEMORY_LIMIT, OP, unsigned, width, valueType,
  isComparison, binaryOpcode, floatOpcode, uleb, constant, memoryOperation, allocator, createModule,
} from './wasm.mjs';

function readType(node, structs) {
  if (node.kind === 'arrayType') return `[${readType(node.element, structs)}]`;
  const { token } = node;
  if (!PRINT_TYPES.includes(token.value) && !structs.has(token.value)) {
    throw new SourceError(token, `Неизвестный тип «${token.value}».`);
  }
  return token.value;
}

function requireType(actual, expected, token) {
  if (actual !== expected) {
    throw new SourceError(token, `Ожидался тип ${expected}, получен ${actual ?? 'вызов без результата'}.`);
  }
}

function requireInteger(type, token) {
  if (!INTEGER_TYPES.includes(type)) {
    throw new SourceError(token, 'Здесь нужно целое число.');
  }
}

const arrayHeader = 8;

function simpleBoolean(node) {
  if (node.kind === 'bool') return true;
  if (node.kind !== 'binary') return false;
  const operator = node.token.kind;
  if (operator === '&&' || operator === '||') {
    return simpleBoolean(node.left) && simpleBoolean(node.right);
  }
  return isComparison(operator) && [node.left, node.right].every(
    operand => operand.kind === 'variable' || operand.kind === 'number' || operand.kind === 'bool',
  );
}

class FunctionCompiler {
  constructor(declaration, signature, functions, structs, memory) {
    this.declaration = declaration;
    this.signature = signature;
    this.functions = functions;
    this.structs = structs;
    this.memory = memory;
    this.scopes = [new Map()];
    this.labels = [];
    this.nonNull = new Set();
    this.loops = [];
    this.locals = [];
    this.code = [];
    declaration.params.forEach(({ name }, index) => {
      this.bind(name, signature.params[index], false, index);
    });
  }

  compile() {
    const returns = this.block(this.declaration.body, false);
    const { result } = this.signature;
    if (result !== null) {
      if (!returns) {
        throw new SourceError(this.declaration.name, `Функция должна вернуть ${result} на каждой ветке.`);
      }
      // A Wasm block with no result type does not propagate termination to its parent.
      this.emit(OP.unreachable);
    }
    return { ...this.signature, locals: this.locals, code: this.code };
  }

  emit(...bytes) {
    this.code.push(...bytes);
  }

  indexed(opcode, index) {
    this.emit(opcode, ...uleb(index));
  }

  newLocal(type) {
    return this.signature.params.length + this.locals.push(type) - 1;
  }

  bind(token, type, mutable, index = this.newLocal(type)) {
    const scope = this.scopes.at(-1);
    if (scope.has(token.value)) {
      throw new SourceError(token, `Имя «${token.value}» уже объявлено в этом блоке.`);
    }
    const local = { type, mutable, index };
    scope.set(token.value, local);
    return local;
  }

  lookup(token) {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const local = this.scopes[index].get(token.value);
      if (local) return local;
    }
    throw new SourceError(token, `Переменная «${token.value}» не объявлена.`);
  }

  control(opcode, type = null) {
    const label = { nonNull: this.nonNull };
    this.labels.push(label);
    this.nonNull = new Set(this.nonNull);
    this.emit(opcode, valueType(type));
    return label;
  }

  elseControl() {
    this.nonNull = new Set(this.labels.at(-1).nonNull);
    this.emit(OP.else);
  }

  endControl() {
    this.nonNull = this.labels.pop().nonNull;
    this.emit(OP.end);
  }

  branch(opcode, label) {
    this.indexed(opcode, this.labels.length - 1 - this.labels.lastIndexOf(label));
  }

  block(statements, scoped = true) {
    if (scoped) this.scopes.push(new Map());
    let returns = false;
    for (const statement of statements) {
      const exits = this.statement(statement);
      returns ||= exits;
    }
    if (scoped) this.scopes.pop();
    return returns;
  }

  statement(node) {
    switch (node.kind) {
      case 'declare': {
        const type = this.expression(node.value);
        if (node.type) requireType(type, readType(node.type, this.structs), node.value.token);
        const local = this.bind(node.name, type, node.mutable);
        this.indexed(OP.set, local.index);
        const allocated = node.value.kind === 'newArray'
          || (node.value.kind === 'call' && this.structs.has(node.value.token.value));
        if (!node.mutable && allocated) this.nonNull.add(local.index);
        return false;
      }
      case 'assign': {
        const { target } = node;
        if (target.kind === 'variable') {
          const local = this.lookup(target.token);
          if (!local.mutable) {
            throw new SourceError(target.token, `«${target.token.value}» нельзя изменить. Объявите переменную через var.`);
          }
          requireType(this.expression(node.value), local.type, node.value.token);
          this.indexed(OP.set, local.index);
        } else {
          const { type, offset } = this.address(target, true);
          requireType(this.expression(node.value), type, node.value.token);
          this.emit(...memoryOperation(type, true, offset));
        }
        return false;
      }
      case 'callStatement': {
        if (this.call(node.value) !== null) this.emit(OP.drop);
        return false;
      }
      case 'return': {
        const { result } = this.signature;
        if (node.value === null && result !== null) {
          throw new SourceError(node.token, `return должен вернуть значение типа ${result}.`);
        }
        if (node.value !== null) {
          if (result === null) {
            throw new SourceError(node.token, 'Эта функция возвращается без значения.');
          }
          requireType(this.expression(node.value), result, node.value.token);
        }
        this.emit(OP.return);
        return true;
      }
      case 'if': {
        requireType(this.expression(node.condition), 'bool', node.condition.token);
        this.control(OP.if);
        const bodyReturns = this.block(node.body);
        let fallbackReturns = false;
        if (node.fallback) {
          this.elseControl();
          fallbackReturns = this.block(node.fallback);
        }
        this.endControl();
        return bodyReturns && fallbackReturns;
      }
      case 'while':
        this.whileLoop(node);
        return false;
      case 'for':
        this.forLoop(node);
        return false;
      case 'break':
      case 'continue': {
        const loop = this.loops.at(-1);
        if (!loop) {
          throw new SourceError(node.token, `«${node.kind}» можно использовать только внутри цикла.`);
        }
        this.branch(OP.br, loop[node.kind]);
        return false;
      }
    }
  }

  whileLoop(node) {
    const exit = this.control(OP.block);
    const always = node.condition.kind === 'bool' && node.condition.value;
    if (!always) {
      requireType(this.expression(node.condition), 'bool', node.condition.token);
      this.emit(OP.eqz);
      this.branch(OP.brIf, exit);
    }
    const repeat = this.control(OP.loop);
    const next = always ? repeat : this.control(OP.block);
    this.loops.push({ break: exit, continue: next });
    this.block(node.body);
    this.loops.pop();
    if (always) {
      this.branch(OP.br, repeat);
    } else {
      this.endControl();
      requireType(this.expression(node.condition), 'bool', node.condition.token);
      this.branch(OP.brIf, repeat);
    }
    this.endControl();
    this.endControl();
  }

  forLoop(node) {
    const type = this.expression(node.start);
    requireInteger(type, node.start.token);
    const iterator = this.newLocal(type);
    this.indexed(OP.set, iterator);
    requireType(this.expression(node.end), type, node.end.token);
    const limit = this.newLocal(type);
    this.indexed(OP.set, limit);

    const exit = this.control(OP.block);
    this.indexed(OP.get, iterator);
    this.indexed(OP.get, limit);
    this.emit(binaryOpcode('>=', type));
    this.branch(OP.brIf, exit);
    const repeat = this.control(OP.loop);
    const next = this.control(OP.block);
    this.loops.push({ break: exit, continue: next });
    this.scopes.push(new Map());
    this.bind(node.name, type, false, iterator);
    this.block(node.body, false);
    this.scopes.pop();
    this.loops.pop();
    this.endControl();
    this.indexed(OP.get, iterator);
    this.emit(...constant(type, 1n), binaryOpcode('+', type));
    this.indexed(OP.tee, iterator);
    this.indexed(OP.get, limit);
    // The range ascends by one, so it reaches its exclusive bound before wrapping.
    this.emit(binaryOpcode('!=', type));
    this.branch(OP.brIf, repeat);
    this.endControl();
    this.endControl();
  }

  expression(node) {
    switch (node.kind) {
      case 'number':
        return this.number(node.token);
      case 'bool':
        this.emit(...constant('bool', node.value ? 1n : 0n));
        return 'bool';
      case 'variable': {
        const local = this.lookup(node.token);
        this.indexed(OP.get, local.index);
        return local.type;
      }
      case 'unary':
        return this.unary(node);
      case 'binary':
        return this.binary(node);
      case 'newArray':
        return this.newArray(node);
      case 'field':
      case 'index': {
        const { type, offset } = this.address(node);
        this.emit(...memoryOperation(type, false, offset));
        return type;
      }
      case 'call': {
        const type = this.call(node);
        if (type === null) {
          throw new SourceError(node.token, `Вызов «${node.token.value}» не возвращает значение.`);
        }
        return type;
      }
    }
  }

  number(token, negative = false) {
    const digits = token.value.replaceAll('_', '');
    const float = /^\d+(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)$/.test(digits);
    if (float) {
      if (!/^\d+(?:_\d+)*(?:\.\d+(?:_\d+)*(?:[eE][+-]?\d+(?:_\d+)*)?|[eE][+-]?\d+(?:_\d+)*)$/.test(token.value)) {
        throw new SourceError(token, `Некорректное число «${token.value}».`);
      }
      const value = Number(digits);
      if (!Number.isFinite(value)) throw new SourceError(token, 'Число выходит за диапазон f64.');
      this.emit(...constant('f64', negative ? -value : value));
      return 'f64';
    }
    const match = /^(0x[0-9a-f]+(?:_[0-9a-f]+)*|[0-9]+(?:_[0-9]+)*)(i32|u32|i64|u64)?$/i.exec(token.value);
    if (!match) throw new SourceError(token, `Некорректное число «${token.value}».`);
    const type = match[2]?.toLowerCase() ?? 'i32';
    if (negative && unsigned(type)) {
      throw new SourceError(token, `У типа ${type} нет отрицательных литералов.`);
    }
    const magnitude = BigInt(match[1].replaceAll('_', ''));
    const value = negative ? -magnitude : magnitude;
    const bits = width(type);
    const narrowed = unsigned(type) ? BigInt.asUintN(bits, value) : BigInt.asIntN(bits, value);
    if (narrowed !== value) {
      throw new SourceError(token, `Число ${negative ? '-' : ''}${token.value} выходит за диапазон ${type}.`);
    }
    this.emit(...constant(type, value));
    return type;
  }

  unary(node) {
    const operator = node.token.kind;
    if (operator === '-' && node.value.kind === 'number') return this.number(node.value.token, true);
    const type = this.expression(node.value);
    if (operator === '!') {
      requireType(type, 'bool', node.value.token);
      this.emit(OP.eqz);
      return 'bool';
    }
    if (operator === '-' && type === 'f64') {
      this.emit(OP.f64Neg);
      return type;
    }
    requireInteger(type, node.value.token);
    if (operator === '~') {
      this.emit(...constant(type, -1n), binaryOpcode('^', type));
    } else {
      if (unsigned(type)) throw new SourceError(node.token, `Унарный «-» требует знаковый тип.`);
      this.emit(...constant(type, -1n), binaryOpcode('*', type));
    }
    return type;
  }

  binary(node) {
    const operator = node.token.kind;
    const type = this.expression(node.left);
    if (operator === '&&' || operator === '||') {
      requireType(type, 'bool', node.left.token);
      // Comparisons and boolean literals cannot trap and always produce 0 or 1.
      if (simpleBoolean(node.left) && simpleBoolean(node.right)) {
        requireType(this.expression(node.right), 'bool', node.right.token);
        this.i32Binary(operator === '&&' ? '&' : '|');
        return 'bool';
      }
      this.control(OP.if, 'bool');
      if (operator === '||') {
        this.emit(...constant('bool', 1n));
        this.elseControl();
      }
      requireType(this.expression(node.right), 'bool', node.right.token);
      if (operator === '&&') {
        this.elseControl();
        this.emit(...constant('bool', 0n));
      }
      this.endControl();
      return 'bool';
    }

    if (type === 'f64') {
      const opcode = floatOpcode(operator);
      if (opcode === undefined) throw new SourceError(node.token, `Оператор «${operator}» не поддерживает f64.`);
      requireType(this.expression(node.right), type, node.right.token);
      this.emit(opcode);
      return isComparison(operator) ? 'bool' : type;
    }
    if (operator !== '==' && operator !== '!=') requireInteger(type, node.left.token);
    requireType(this.expression(node.right), type, node.right.token);
    this.emit(binaryOpcode(operator, type));
    return isComparison(operator) ? 'bool' : type;
  }

  call(node) {
    const { token, args } = node;
    const name = token.value;
    const structure = this.structs.get(name);
    if (structure) return this.construct(node, structure);
    if (name === 'print' || INTEGER_TYPES.includes(name) || name === 'f64') {
      if (args.length !== 1) throw new SourceError(token, `«${name}» принимает один аргумент.`);
      const type = this.expression(args[0]);
      if (name === 'print') {
        if (!PRINT_TYPES.includes(type)) throw new SourceError(token, 'print принимает число или bool.');
        if (type === 'f64') this.emit(OP.reinterpretF64);
        else if (width(type) === 32) this.extend(type);
        this.emit(...constant('i32', BigInt(PRINT_TYPES.indexOf(type))));
        this.indexed(OP.call, 0);
        return null;
      }
      this.convert(type, name, args[0].token);
      return name;
    }

    const signature = this.functions.get(name);
    if (!signature) throw new SourceError(token, `Функция «${name}» не объявлена.`);
    if (signature.params.length !== args.length) {
      throw new SourceError(token, `Функция «${name}» ожидает аргументов: ${signature.params.length}. Получено: ${args.length}.`);
    }
    args.forEach((arg, index) => requireType(this.expression(arg), signature.params[index], arg.token));
    this.indexed(OP.call, signature.index);
    return signature.result;
  }

  convert(type, target, token) {
    if (type === target) return;
    if (type !== 'f64') requireInteger(type, token);
    if (type === 'f64') {
      const opcode = width(target) === 32 ? 0xaa : 0xb0;
      this.emit(opcode + Number(unsigned(target)));
    } else if (target === 'f64') {
      const opcode = width(type) === 32 ? 0xb7 : 0xb9;
      this.emit(opcode + Number(unsigned(type)));
    } else if (width(type) < width(target)) {
      this.extend(type);
    } else if (width(type) > width(target)) {
      this.emit(OP.wrap);
    }
  }

  extend(type) {
    this.emit(unsigned(type) ? OP.extendUnsigned : OP.extendSigned);
  }

  i32(value) {
    this.emit(...constant('i32', BigInt(value)));
  }

  i32Binary(operator) {
    this.emit(binaryOpcode(operator, 'i32'));
  }

  trapIf() {
    this.control(OP.if);
    this.emit(OP.unreachable);
    this.endControl();
  }

  checkReference(local, immutable) {
    if (immutable && this.nonNull.has(local)) return;
    this.indexed(OP.get, local);
    this.emit(OP.eqz);
    this.trapIf();
    // Only immutable locals retain the same address across calls and loop iterations.
    if (immutable) this.nonNull.add(local);
  }

  allocate() {
    this.memory.used = true;
    this.memory.allocates = true;
    this.indexed(OP.call, this.memory.allocatorIndex);
  }

  newArray(node) {
    const element = readType(node.element, this.structs);
    const stride = width(element) / 8;
    requireType(this.expression(node.length), 'i32', node.length.token);
    const length = this.newLocal('i32');
    this.indexed(OP.tee, length);
    this.i32(Math.floor((MEMORY_LIMIT - arrayHeader) / stride));
    this.emit(binaryOpcode('>', 'u32'));
    this.trapIf();

    this.indexed(OP.get, length);
    this.i32(stride);
    this.i32Binary('*');
    this.i32(arrayHeader);
    this.i32Binary('+');
    this.allocate();
    const reference = this.newLocal('i32');
    this.indexed(OP.tee, reference);
    this.indexed(OP.get, length);
    this.emit(...memoryOperation('i32', true));
    this.indexed(OP.get, reference);
    return `[${element}]`;
  }

  construct(node, structure) {
    const { name, fields } = structure;
    if (node.args.length !== fields.size) {
      throw new SourceError(node.token, `«${name}» принимает ${fields.size} значений полей.`);
    }
    this.i32(Math.max(8, fields.size * 8));
    this.allocate();
    const reference = this.newLocal('i32');
    this.indexed(OP.set, reference);
    let index = 0;
    for (const { type, offset } of fields.values()) {
      const argument = node.args[index++];
      this.indexed(OP.get, reference);
      requireType(this.expression(argument), type, argument.token);
      this.emit(...memoryOperation(type, true, offset));
    }
    this.indexed(OP.get, reference);
    return name;
  }

  address(node, writing = false) {
    this.memory.used = true;
    const base = node.base.kind === 'variable' ? this.lookup(node.base.token) : null;
    const baseType = base ? base.type : this.expression(node.base);
    const reference = base ? base.index : this.newLocal('i32');
    if (!base) this.indexed(OP.set, reference);
    const isArray = baseType.startsWith('[');
    if (node.kind === 'index') {
      if (!isArray) throw new SourceError(node.token, 'Индексировать можно только массив.');
      requireType(this.expression(node.index), 'i32', node.index.token);
      const index = this.newLocal('i32');
      this.indexed(OP.set, index);
      this.checkReference(reference, base && !base.mutable);
      this.indexed(OP.get, index);
      this.indexed(OP.get, reference);
      this.emit(...memoryOperation('i32', false));
      this.emit(binaryOpcode('>=', 'u32'));
      this.trapIf();
      const type = baseType.slice(1, -1);
      this.indexed(OP.get, reference);
      this.indexed(OP.get, index);
      this.i32(width(type) / 8);
      this.i32Binary('*');
      this.i32Binary('+');
      return { type, offset: arrayHeader };
    }

    const name = node.token.value;
    let field = this.structs.get(baseType)?.fields.get(name);
    if (isArray && name === 'length') {
      if (writing) throw new SourceError(node.token, 'Длину массива нельзя изменить.');
      field = { type: 'i32', offset: 0 };
    }
    if (!field) throw new SourceError(node.token, `У типа ${baseType} нет поля «${name}».`);
    this.checkReference(reference, base && !base.mutable);
    this.indexed(OP.get, reference);
    return field;
  }
}

export function compile(source, { shared = false } = {}) {
  const { declarations, usesPrint } = parse(source);
  const structs = new Map();
  const names = new Set(['print', ...PRINT_TYPES]);
  for (const { kind, name } of declarations) {
    if (names.has(name.value)) throw new SourceError(name, `Имя «${name.value}» уже занято.`);
    names.add(name.value);
    if (kind === 'struct') {
      if (name.value === 'main') throw new SourceError(name, 'Имя main закреплено за точкой входа.');
      structs.set(name.value, { name: name.value, fields: new Map() });
    }
  }
  for (const { kind, name, fields } of declarations) {
    if (kind !== 'struct') continue;
    const target = structs.get(name.value).fields;
    for (const field of fields) {
      const { name, type } = field;
      if (target.has(name.value)) throw new SourceError(name, `Поле «${name.value}» уже объявлено.`);
      target.set(name.value, { type: readType(type, structs), offset: target.size * 8 });
    }
  }

  const imports = usesPrint ? [{ module: 'yasno', field: 'print', params: ['i64', 'i32'], result: null }] : [];
  const externs = declarations.filter(declaration => declaration.kind === 'extern');
  const definitions = declarations.filter(declaration => declaration.kind === 'function');
  if (shared && usesPrint) {
    throw new SourceError(definitions[0].name, 'В общей библиотеке печать нужно объявить через extern.');
  }
  const signatures = new Map();
  const exportNames = new Map();
  for (const declaration of [...externs, ...definitions]) {
    const { name, params, result, kind, exported, exportName } = declaration;
    if (name.value === 'main' && (kind === 'extern' || params.length !== 0 || result !== null || (exportName && exportName.value !== 'main'))) {
      throw new SourceError(name, 'Точка входа объявляется как fn main() без параметров и результата.');
    }
    const publicName = exportName?.value ?? (exported || name.value === 'main' ? name.value : null);
    if (publicName !== null) {
      if (exportNames.has(publicName) || (publicName === 'main' && name.value !== 'main')) {
        throw new SourceError(exportName ?? name, `Имя экспорта «${publicName}» уже занято.`);
      }
      exportNames.set(publicName, exportName ?? name);
    }
    const signature = {
      name: name.value,
      index: signatures.size + Number(usesPrint),
      exportName: publicName,
      params: params.map(param => readType(param.type, structs)),
      result: result ? readType(result, structs) : null,
    };
    if (shared && [...signature.params, signature.result].some(type => type !== null && !PRINT_TYPES.includes(type))) {
      throw new SourceError(name, 'Общая библиотека принимает и возвращает только скалярные типы.');
    }
    signatures.set(name.value, signature);
    if (kind === 'extern') {
      const module = declaration.module.value;
      const field = declaration.field.value;
      if (module === 'yasno' && field === 'print') {
        throw new SourceError(declaration.field, 'Импорт yasno.print закреплён за встроенной функцией print.');
      }
      imports.push({ ...signature, module, field });
    }
  }
  const memory = { used: false, allocates: false, allocatorIndex: imports.length + definitions.length };
  const functions = definitions.map(declaration =>
    new FunctionCompiler(declaration, signatures.get(declaration.name.value), signatures, structs, memory).compile(),
  );
  if (memory.allocates) functions.push(allocator());
  if (shared && memory.used) {
    throw new SourceError(definitions[0].name, 'Общая библиотека Yasno пока не поддерживает массивы и структуры.');
  }
  if (memory.used && exportNames.has('memory')) {
    throw new SourceError(exportNames.get('memory'), 'Имя экспорта «memory» занято линейной памятью.');
  }
  return createModule(imports, functions, memory.used, shared);
}
