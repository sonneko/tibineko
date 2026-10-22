# `gen/` — the generator

TypeScript, runs on plain `node` (>= 22.6, which strips types natively).
No `package.json`, no `node_modules`, no build step.

```bash
node self_test.ts   # 16 tests
```

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

`index.ts` is the entry point: `generate(config)` reads the two inputs, runs
the pipeline, and writes the declared targets. It never shells out.

`check_ast_size.ts` is the one piece with a host-tool dependency — it emits a
`#[ignore]`d Rust test that prints `size_of::<T>()` for every AST struct, which
you then run through `cargo test` yourself. It is opt-in and not part of
`generate()`.

## Files

| File | Lines | Role |
|---|---|---|
| `analyze.ts` | 697 | the compiler: FIRST/FOLLOW/nullable, cycle detection, LL(2) checks. Also `TokenMap`. |
| `tests.ts` | 447 | unit tests for the above. |
| `gen_ast_type.ts` | 276 | emits AST enums/structs, `ASTNode` impls, the `ASTVisitor` trait. |
| `parse.ts` | 258 | DSL lexer + parser. |
| `gen_parser.ts` | 236 | emits the `GeneratedParser` trait. |
| `gen_ast_printer.ts` | 131 | emits the visitor that prints JSON. |
| `gen_tokenmap.ts` | 114 | emits scanner tables (longest-match trie + `phf` map). |
| `gen_mermaid.ts` | 104 | grammar diagram. |
| `ir.ts` | 89 | the intermediate representation. |
| `ast.ts` | 80 | DSL types and lexing patterns. |
| `gen.ts` | 32 | fans the IR out to the three Rust emitters. |
| `check_ast_size.ts` | 33 | AST size reporting. |

## Where to look first

- **Branch dispatch** — `gen_parser.ts` splits alternatives into what is
  decidable at `peek(0)`, what needs `peek(1)`, and what needs backtracking.
  `analyze.ts:analyzeBranchRule` does the classification.
- **Boxing** — `analyze.ts:computeCycle` walks the rule graph, ignoring edges
  through `*lists` (an `ArenaIter` is already a handle), and marks inline
  back-edges as boxed.
- **Recovery** — the generated code calls into `runtime/recovery.rs`, which
  skips to the next FIRST/FOLLOW synchronization point.

Anything language-specific is tagged `// TIBINEKO-FORK:` — 13 markers.
