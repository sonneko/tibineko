# `gen/` — the generator

TypeScript, runs on plain `node` (>= 22.6, which strips types natively).
No `package.json`, no `node_modules`, no build step.

```bash
node self_test.ts   # 16 tests, 0 failures
```

Keeping it dependency-free is a deliberate constraint, and CI enforces it: the
Generator job fails if a `package.json` or `node_modules` appears anywhere in
the repository.

## Pipeline

```
grammar.tibineko  tokenmap.csv
        │               │
        ▼               │
   parse.ts ──── ast.ts │        Grammar = Rule[]  (branch | product)
        │               │
        ▼               ▼
      analyze.ts  ◄─────┘        nullable, FIRST (token pairs), FOLLOW,
        │                        cycle -> auto-boxing, LL(2) conflicts
        ▼
       ir.ts                     IR = ParserFunction[]
        │
        ├── gen_parser.ts      -> generated_parser.rs
        ├── gen_ast_type.ts    -> generated_ast.rs
        ├── gen_ast_printer.ts -> generated_ast_printer.rs
        ├── gen_tokenmap.ts    -> generated_tokenmap.rs
        └── gen_mermaid.ts     -> mermaid_grammar.html
```

## API

`index.ts` is the entry point. One function does everything:

```ts
generate(cfg: TibinekoConfig): GenerateResult
```

It reads the two inputs, runs the pipeline, and writes the declared targets. It
does no other I/O and **never shells out** — the `cargo test` round trip lives in
`check_ast_size.ts` and is opt-in.

`TibinekoConfig`:

| Field | Meaning |
|---|---|
| `grammar` | path to the `.tibineko` file |
| `tokenMap` | path to the token map CSV |
| `targets.{parser, ast, printer, tokenMap, astSizeChecker}` | output paths. Omit a key to skip that artifact. Used verbatim, so you decide where things land. |
| `specDir` | also write `ast.json`, `ir.json`, `mermaid_grammar.html` |
| `astSizeLimit` | warn above this many bytes per AST struct |
| `verbose` | log the analyzer's warnings |

`GenerateResult` carries `analysisOutput` (the FIRST/FOLLOW warnings), `written`
(the files, in order), and `astSizes` when the size checker ran.

There is deliberately no config-file schema and no CLI flag parser. You own a
~10 line entry script instead — see [`../seed/gen.ts`](../seed/gen.ts).

Also exported: `astTypeNames(grammarPath)`, used to drive the size checker.

`check_ast_size.ts` is the one piece with a host-tool dependency — it emits a
`#[ignore]`d Rust test that prints `size_of::<T>()` for every AST struct between
`===BEGIN_REPORT===` and `===END_REPORT===`, which you run through `cargo test`
yourself and feed back through `parseASTSizeCheckerResult`.

## Files

| File | Lines | Role |
|---|---|---|
| `analyze.ts` | 697 | the compiler: FIRST/FOLLOW/nullable, cycle detection, LL(2) checks. Also `TokenMap`. |
| `tests.ts` | 447 | unit tests for the above. |
| `gen_ast_type.ts` | 278 | emits AST enums/structs, `ASTNode` impls, the `ASTVisitor` trait. |
| `parse.ts` | 258 | DSL lexer + parser. |
| `gen_parser.ts` | 238 | emits the `GeneratedParser` trait. |
| `gen_ast_printer.ts` | 133 | emits the visitor that prints JSON. |
| `gen_tokenmap.ts` | 119 | emits scanner tables (longest-match trie + `phf` map). |
| `index.ts` | 110 | `generate()` and `TibinekoConfig`. |
| `gen_mermaid.ts` | 104 | grammar diagram. |
| `ir.ts` | 89 | the intermediate representation. |
| `ast.ts` | 80 | DSL types, the BNF, and the lexer's token patterns. |
| `test_utility.ts` | 55 | the `describe`/`it`/`match` mini-harness the tests use. |
| `check_ast_size.ts` | 33 | AST size reporting. |
| `gen.ts` | 32 | fans the IR out to the three Rust emitters. |
| `self_test.ts` | 1 | `import "./tests.ts";` — the entry point for `node`. |

15 files, 2674 lines.

## Where to look first

- **Branch dispatch** — `gen_parser.ts` splits alternatives into what is
  decidable at `peek(0)`, what needs `peek(1)`, and what needs backtracking.
  `analyze.ts:analyzeBranchRule` does the classification.
- **Boxing** — `analyze.ts:computeCycle` walks the rule graph, ignoring edges
  through `*lists` (an `ArenaIter` is already a handle), and marks inline
  back-edges as boxed.
- **Hand-written nodes** — `gen_parser.ts:184`: a product becomes hand-written
  when a terminal's token expression contains `$` or equals `Token::Invalid`.
  `gen_ast_type.ts` then emits `pub use crate::parser::manual_ast::X;` instead
  of a struct.
- **Recovery** — the generated code calls into `runtime/recovery.rs`, which
  skips to the next FIRST/FOLLOW synchronization point.

## Quirks

- **The IR has a `hook` kind that is never produced.** `ir.ts` declares it and
  four emitters branch on it, but nothing creates one. Hand-written nodes go
  through the `$`/`Invalid` check instead.
- **Upstream's typos are load-bearing.** `checkLL2Confilict` and
  `dublicateRemoved` are misspelled in hydent-lang and stay misspelled here,
  because renaming them would break consumers. Same for `Enviroment` on the
  Rust side.
- **`TokenMap` is stricter than upstream's.** It throws on duplicate literals
  and on a literal with no entry, where hydent-lang silently took the last
  definition. See [`../docs/token-map.md`](../docs/token-map.md).

Anything language-specific is tagged `// TIBINEKO-FORK:` — 13 markers across 6
files. `grep -rn 'TIBINEKO-FORK' gen/` lists them.
