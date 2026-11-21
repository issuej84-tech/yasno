const keywords = new Set([
  'fn', 'export', 'let', 'var', 'if', 'else', 'while', 'for', 'in',
  'return', 'break', 'continue', 'true', 'false', 'struct', 'new', 'extern',
]);

const precedences = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='],
  ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%'],
];

const precedence = new Map(precedences.flatMap((group, index) =>
  group.map(operator => [operator, index + 1]),
));

export class SourceError extends Error {
  constructor(token, message) {
    super(message);
    this.token = token;
  }
}

function tokenize(source) {
  const tokens = [];
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const pattern = /\s+|\/\/.*|"(?:[^"\\]|\\.)*"|[a-zA-Z_][a-zA-Z_0-9]*|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?[a-zA-Z_0-9]*|->|\.\.|==|!=|<=|>=|<<|>>|&&|\|\||[()[\]{}.:,;=+*/%<>!~&|^-]/y;

  for (const [index, line] of lines.entries()) {
    let offset = 0;
    while (offset < line.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(line);
      const token = { line: index + 1, column: offset + 1 };
      if (!match) {
        throw new SourceError(token, `Недопустимый символ «${line[offset]}».`);
      }
      const [value] = match;
      offset = pattern.lastIndex;
      if (/^\s/.test(value) || value.startsWith('//')) continue;

      let kind = value;
      if (value.startsWith('"')) kind = 'text';
      else if (/^[0-9]/.test(value)) kind = 'number';
      else if (/^[a-zA-Z_]/.test(value) && !keywords.has(value)) kind = 'name';
      tokens.push({ ...token, kind, value });
    }
    tokens.push({ kind: '\n', value: '\n', line: index + 1, column: line.length + 1 });
  }
  tokens.push({ ...tokens.at(-1), kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.position = 0;
    this.usesPrint = false;
  }

  get token() {
    return this.tokens[this.position];
  }

  at(kind) {
    return this.token.kind === kind;
  }

  take(kind) {
    if (this.at(kind)) return this.tokens[this.position++];
    return undefined;
  }

  expect(kind, message = `Ожидалось «${kind}».`) {
    const token = this.take(kind);
    if (!token) throw new SourceError(this.token, message);
    return token;
  }

  lines() {
    while (this.take('\n')) {}
  }

  separators() {
    while (this.take('\n') || this.take(';')) {}
  }

  program() {
    const declarations = [];
    this.separators();
    while (!this.at('eof')) {
      if (this.take('struct')) declarations.push(this.structure());
      else if (this.take('extern')) declarations.push(this.external());
      else declarations.push(this.function());
      this.separators();
    }
    return { declarations, usesPrint: this.usesPrint };
  }

  function() {
    const exported = this.take('export');
    const exportName = exported && this.at('text') ? this.text() : null;
    return { kind: 'function', ...this.signature(), exported: Boolean(exported), exportName, body: this.block() };
  }

  signature() {
    this.expect('fn', 'Ожидалось объявление функции через fn.');
    const name = this.expect('name', 'Ожидалось имя функции.');
    this.expect('(');
    const params = this.list(() => this.binding('Ожидалось имя параметра.'));
    const result = this.take('->') ? this.type() : null;
    return { name, params, result };
  }

  text() {
    const token = this.expect('text', 'Ожидалось имя в двойных кавычках.');
    try {
      return { ...token, value: JSON.parse(token.value) };
    } catch {
      throw new SourceError(token, 'Некорректная строка в двойных кавычках.');
    }
  }

  external() {
    const module = this.text();
    const field = this.text();
    const declaration = { kind: 'extern', module, field, ...this.signature() };
    if (!this.endOfStatement()) throw new SourceError(this.token, 'Ожидался конец объявления extern.');
    return declaration;
  }

  type() {
    const bracket = this.take('[');
    if (bracket) {
      const element = this.type();
      this.expect(']');
      return { kind: 'arrayType', token: bracket, element };
    }
    const token = this.expect('name', 'Ожидалось имя типа.');
    return { kind: 'namedType', token };
  }

  binding(message) {
    const name = this.expect('name', message);
    this.expect(':');
    return { name, type: this.type() };
  }

  structure() {
    const name = this.expect('name', 'Ожидалось имя структуры.');
    this.lines();
    this.expect('{');
    this.lines();
    const fields = [];
    while (!this.take('}')) {
      fields.push(this.binding('Ожидалось имя поля.'));
      if (this.take(',')) this.lines();
      else if (!this.at('}')) this.expect('\n', 'Разделите поля запятыми или переводом строки.');
      this.lines();
    }
    return { kind: 'struct', name, fields };
  }

  list(readItem) {
    const items = [];
    this.lines();
    while (!this.take(')')) {
      items.push(readItem());
      this.lines();
      if (this.take(')')) break;
      this.expect(',');
      this.lines();
    }
    return items;
  }

  block() {
    this.lines();
    this.expect('{');
    const statements = [];
    this.separators();
    while (!this.take('}')) {
      if (this.at('eof')) throw new SourceError(this.token, 'Ожидалась закрывающая «}».');
      statements.push(this.statement());
      this.separators();
    }
    return statements;
  }

  endOfStatement() {
    return this.at('\n') || this.at(';') || this.at('}') || this.at('eof');
  }

  statement() {
    const token = this.token;
    switch (token.kind) {
      case 'if': {
        this.position++;
        const condition = this.expression();
        const body = this.block();
        this.lines();
        let fallback = null;
        if (this.take('else')) {
          this.lines();
          fallback = this.at('if') ? [this.statement()] : this.block();
        }
        return { kind: 'if', token, condition, body, fallback };
      }
      case 'while': {
        this.position++;
        const condition = this.expression();
        return { kind: 'while', token, condition, body: this.block() };
      }
      case 'for': {
        this.position++;
        const name = this.expect('name', 'Ожидалось имя переменной цикла.');
        this.expect('in');
        const start = this.expression();
        this.expect('..');
        this.lines();
        const end = this.expression();
        return { kind: 'for', token, name, start, end, body: this.block() };
      }
      default: {
        const statement = this.simpleStatement();
        if (!this.endOfStatement()) {
          throw new SourceError(this.token, 'Ожидался конец строки, «;» или «}».');
        }
        return statement;
      }
    }
  }

  simpleStatement() {
    const token = this.token;
    switch (token.kind) {
      case 'let':
      case 'var': {
        this.position++;
        const name = this.expect('name', 'Ожидалось имя переменной.');
        const type = this.take(':') ? this.type() : null;
        this.expect('=');
        this.lines();
        return { kind: 'declare', token, name, type, mutable: token.kind === 'var', value: this.expression() };
      }
      case 'return':
        this.position++;
        return { kind: 'return', token, value: this.endOfStatement() ? null : this.expression() };
      case 'break':
      case 'continue':
        this.position++;
        return { kind: token.kind, token };
      default: {
        const value = this.expression();
        if (this.take('=')) {
          if (!['variable', 'field', 'index'].includes(value.kind)) {
            throw new SourceError(value.token, 'Присваивать можно переменной, полю или элементу массива.');
          }
          this.lines();
          return { kind: 'assign', token, target: value, value: this.expression() };
        }
        if (value.kind !== 'call') {
          throw new SourceError(token, 'Ожидалось присваивание или вызов функции.');
        }
        return { kind: 'callStatement', token, value };
      }
    }
  }

  expression(minimum = 1, multiline = false) {
    let left = this.prefix(multiline);
    if (multiline) this.lines();
    while ((precedence.get(this.token.kind) ?? 0) >= minimum) {
      const operator = this.tokens[this.position++];
      this.lines();
      const right = this.expression(precedence.get(operator.kind) + 1, multiline);
      left = { kind: 'binary', token: operator, left, right };
    }
    return left;
  }

  prefix(multiline) {
    let value = this.primary(multiline);
    while (true) {
      if (this.take('.')) {
        const name = this.expect('name', 'Ожидалось имя поля.');
        value = { kind: 'field', token: name, base: value };
      } else {
        const bracket = this.take('[');
        if (!bracket) return value;
        this.lines();
        const index = this.expression(1, true);
        this.expect(']');
        value = { kind: 'index', token: bracket, base: value, index };
      }
    }
  }

  primary(multiline) {
    const token = this.tokens[this.position++];
    switch (token.kind) {
      case '(':
        this.lines();
        const value = this.expression(1, true);
        this.expect(')');
        return value;
      case '-':
      case '!':
      case '~':
        this.lines();
        return { kind: 'unary', token, value: this.prefix(multiline) };
      case 'number':
        return { kind: 'number', token };
      case 'new': {
        this.expect('[');
        const element = this.type();
        this.expect(']');
        this.expect('(');
        this.lines();
        const length = this.expression(1, true);
        this.expect(')');
        return { kind: 'newArray', token, element, length };
      }
      case 'true':
      case 'false':
        return { kind: 'bool', token, value: token.kind === 'true' };
      case 'name':
        if (multiline) this.lines();
        if (this.take('(')) {
          if (token.value === 'print') this.usesPrint = true;
          return { kind: 'call', token, args: this.list(() => this.expression(1, true)) };
        }
        return { kind: 'variable', token };
      default:
        throw new SourceError(token, 'Ожидалось выражение.');
    }
  }
}

export function parse(source) {
  return new Parser(source).program();
}
