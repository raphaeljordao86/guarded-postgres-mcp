// A small PostgreSQL lexer for the guardrails. It is not a parser: it only
// turns SQL text into tokens the way the server would, so the checks never
// mistake a comment or a string for code (or the other way around).
//
// What it knows about, following the PostgreSQL lexical rules:
//   - `--` line comments and `/* */` block comments, which NEST in PostgreSQL;
//     a comment is dropped, which is the same as whitespace;
//   - '...' strings with '' escapes, E'...' strings with backslash escapes,
//     B'', X'', N'' and U&'' strings, and $tag$...$tag$ dollar quotes;
//   - "..." quoted identifiers with "" escapes (and U&"...");
//   - parentheses, which give every token its nesting depth.
//
// Plain '...' strings depend on a server setting: with
// standard_conforming_strings = off (still found on old ERP databases) a
// backslash escapes the next character, with it on it does not. The lexer
// cannot know the setting, so `lex()` returns one reading per setting whenever
// the text has a backslash, and the checks must hold under every reading.

const IDENT_START = /[A-Za-z_\u0080-\uffff]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const DIGIT = /[0-9]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;

/**
 * Index just past the closing quote of the string that opens at `start`.
 * An unterminated string runs to the end of the text (the server rejects it).
 */
function skipQuoted(s, start, backslashEscapes) {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      if (s[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

/** Reads a "quoted identifier" that opens at `start`. Returns [end, name]. */
function readQuotedIdent(s, start) {
  let i = start + 1;
  let name = '';
  while (i < s.length) {
    if (s[i] === '"') {
      if (s[i + 1] === '"') {
        name += '"';
        i += 2;
        continue;
      }
      return [i + 1, name];
    }
    name += s[i];
    i++;
  }
  return [s.length, name];
}

/**
 * Tokens of `sql`. Each token is { t, v, d }:
 *   t: 'w' word (keyword or unquoted identifier; also has u = upper case),
 *      'id' quoted identifier (v = the name as written, without quotes),
 *      'str' string constant of any kind (v = the literal as written), 'num',
 *      'param' ($1),
 *      'op' operator character, or one of '(' ')' ',' '.' ';' '[' ']' ':'.
 *   d: parenthesis depth. An opening and its closing parenthesis share the
 *      depth of the text around them; the tokens between are one deeper.
 *   p: offset of the token in the text (for error messages).
 */
export function tokenize(sql, { backslashEscapes = false } = {}) {
  const s = String(sql);
  const n = s.length;
  const out = [];
  let depth = 0;
  let i = 0;
  let start = 0;
  const push = (t, v, extra) => out.push({ t, v, d: depth, p: start, ...extra });

  while (i < n) {
    start = i;
    const c = s[i];
    const c2 = s[i + 1];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '-' && c2 === '-') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      let level = 1;
      i += 2;
      while (i < n && level > 0) {
        if (s[i] === '/' && s[i + 1] === '*') {
          level++;
          i += 2;
        } else if (s[i] === '*' && s[i + 1] === '/') {
          level--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === "'") {
      i = skipQuoted(s, i, backslashEscapes);
      push('str', s.slice(start, i));
      continue;
    }
    if (c === '"') {
      const [end, name] = readQuotedIdent(s, i);
      i = end;
      push('id', name);
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(s[j])) j++;
      const word = s.slice(i, j);
      const up = word.toUpperCase();
      if (s[j] === "'" && (up === 'E' || up === 'B' || up === 'X' || up === 'N')) {
        i = skipQuoted(s, j, up === 'E' ? true : backslashEscapes);
        push('str', s.slice(start, i));
        continue;
      }
      if (up === 'U' && s[j] === '&' && s[j + 1] === "'") {
        // U&'' strings use the backslash for Unicode escapes, not for quotes.
        i = skipQuoted(s, j + 1, false);
        push('str', s.slice(start, i));
        continue;
      }
      if (up === 'U' && s[j] === '&' && s[j + 1] === '"') {
        const [end, name] = readQuotedIdent(s, j + 1);
        i = end;
        push('id', name);
        continue;
      }
      push('w', word, { u: up });
      i = j;
      continue;
    }
    if (c === '$') {
      if (c2 !== undefined && DIGIT.test(c2)) {
        let j = i + 1;
        while (j < n && DIGIT.test(s[j])) j++;
        push('param', s.slice(i, j));
        i = j;
        continue;
      }
      DOLLAR_TAG.lastIndex = i;
      const m = DOLLAR_TAG.exec(s);
      if (m) {
        const close = s.indexOf(m[0], i + m[0].length);
        i = close === -1 ? n : close + m[0].length;
        push('str', s.slice(start, i));
        continue;
      }
      push('op', c);
      i++;
      continue;
    }
    if (DIGIT.test(c) || (c === '.' && c2 !== undefined && DIGIT.test(c2))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(s);
      push('num', m[0]);
      i += m[0].length;
      continue;
    }
    if (c === '(') {
      push('(', c);
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      push(')', c);
      i++;
      continue;
    }
    if (c === ';') {
      // Statements are split at every `;` (see splitStatements), so the depth
      // of the next statement does not inherit unbalanced parentheses.
      push(c, c);
      depth = 0;
      i++;
      continue;
    }
    if (c === ',' || c === '.' || c === '[' || c === ']' || c === ':') {
      push(c, c);
      i++;
      continue;
    }
    push('op', c);
    i++;
  }
  return out;
}

/**
 * Splits a token list into statements at every `;`, dropping empty ones.
 * Splitting even inside parentheses is deliberate: PostgreSQL only accepts a
 * `;` there in the multi-action form of CREATE RULE, and treating that as
 * several statements errs on the safe side.
 */
export function splitStatements(tokens) {
  const statements = [];
  let current = [];
  for (const tk of tokens) {
    if (tk.t === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
    } else {
      current.push(tk);
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

/**
 * Every plausible reading of `sql`, each one a list of statements (token
 * lists). One reading when the text has no backslash, two otherwise.
 */
export function lex(sql) {
  const text = String(sql);
  const readings = [splitStatements(tokenize(text))];
  if (text.includes('\\')) {
    readings.push(splitStatements(tokenize(text, { backslashEscapes: true })));
  }
  return readings;
}
