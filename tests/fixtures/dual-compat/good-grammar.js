// Every construct the pure-literal meta grammar accepts (see readMetaLiteral in
// src/loader.ts). tests/loader.test.ts checks that the parsed meta deep-equals
// what JavaScript itself evaluates this same literal to.
export const meta = /* a comment before the literal */ {
  name: 'good-grammar', // identifier key, single-quoted string
  "description": "double-quoted with escapes: \"q\" \n\t\\ \x41 \u0042 \u{1F600} \0 \$ \a end",
  'single-quoted key': 'it\'s',
  default: 'a reserved word is a fine key',
  $dollar_1: true,
  ünïcödé: false,
  nothing: null,
  42: 'integer key',
  1.5: 'decimal key',
  0x10: 'hex key',
  1_000: 'separator key',
  template: `no interpolation: $5, \${literal}, \`ticks\` and {braces}`,
  multiline: `line one
line two`,
  continued: 'one \
two',
  numbers: [0, -1, +2, 1.25, .5, 5., 1e3, 2E-2, 1.e2, -0x1F, 0o17, 0B101, 1_000_000, 0.000_1, - /* spaced */ 3, -0],
  nested: {
    phases: [{ title: 'A', detail: 'first' }, { title: 'B' },],
    empty: {},
    none: [],
  },
  /* a block comment between properties */
  trailing: 'comma',
};

return meta
