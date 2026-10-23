# `example/` — a second language, as a real crate

A small config-file language, built to prove tibineko is not hydent-specific.
13 grammar rules generate the parser, AST types, printer and scanner tables;
the rest of the crate is the tibineko runtime plus the support modules it needs.

It is a real Cargo crate that CI builds, tests and lints — not a generated
demo.

```bash
node gen.ts        # regenerate the committed Rust from the grammar
cargo build
cargo test --lib   # 16 unit tests
cargo test --test parse   # 9 integration tests
cargo test         # all 25
```

## The grammar

All 13 rules, from [`grammar.tibineko`](grammar.tibineko):

```
Document     ::= entries: *Entry
Entry        ::= Pair | Note
Pair         ::= key: Identifier ":" value: Value ";"
Value        ::= NumberLiteral | StringLiteral | BoolLiteral | ListValue | GroupedValue
GroupedValue ::= "(" value: Value ")"
ListValue    ::= "[" items: *ValueItem "]"
ValueItem    ::= value: Value comma: ?Comma
Comma        with ","
Note         with "#doc_comment"
Identifier   with "#identifier"
NumberLiteral with "#int"
StringLiteral with "#string"
BoolLiteral   with "#bool"
```

The last five use the `$...$` payload convention, so they are hand-written —
see [`../docs/token-map.md`](../docs/token-map.md).

## What it exercises

| Construct | Rule | Why it matters |
|---|---|---|
| `branch` → `enum` | `Entry`, `Value` | variant dispatch on `peek(0)` |
| `product` → `struct` | `Pair`, `ValueItem` | field ordering, terminal matching |
| unit product | `Comma with ","` | single-terminal rule |
| `*list` → `ArenaIter` | `Document.entries`, `ListValue.items` | repetition, FIRST/FOLLOW |
| `?option` → `Option` | `ValueItem.comma` | nullable analysis |
| **inline recursion → `ArenaBox`** | `Value → GroupedValue → Value` | must be boxed or the enum is infinitely sized |
| **recursion through a list** | `Value → ListValue → ValueItem → Value` | must *not* be boxed; `ArenaIter` is already a handle |
| hand-written nodes | `Identifier`, `NumberLiteral`, `StringLiteral`, `BoolLiteral`, `Note` | the `$...$` path |
| **no keywords at all** | — | an empty keyword set must not emit lint warnings |

The two recursion cases are the interesting pair. From `src/parser/generated_ast.rs`:

```rust
pub struct GroupedValue {
    pub(super) value: ArenaBox<Value>,       // boxed: inline cycle
    ...
}

pub struct ListValue {
    pub(super) items: ArenaIter<ValueItem>,  // not boxed: a list is a handle
}
```

`tests/parse.rs::walks_a_deeply_nested_value` walks the boxed cycle at runtime,
so the boxing is exercised, not just asserted by inspection.

## Generated output

Committed, so `cargo build` needs no Node. 811 lines across four files:

| File | Lines |
|---|---|
| `src/parser/generated_ast.rs` | 452 |
| `src/parser/generated_ast_printer.rs` | 177 |
| `src/parser/generated_parser.rs` | 130 |
| `src/tokenizer/generated_tokenmap.rs` | 52 |

CI regenerates and fails on any `git diff`, so these cannot drift from the
grammar.

`spec/` (the `ast.json` / `ir.json` / mermaid output) is gitignored.

## Layout

```
grammar.tibineko          yours
tokenmap.csv              yours
gen.ts                    yours (~20 lines)
Cargo.toml                tibineko_example, edition 2021, phf 0.13.1
src/lib.rs
src/parser/
  generated_*.rs          tibineko output, committed
  ast_node.rs base_parser.rs errors.rs recovery.rs tracer.rs token_stream.rs
                          tibineko runtime, copied
  manual_ast.rs           hand-written AST nodes (5)
  manual_parser.rs        hand-written parse hooks (5)
  parse.rs                the Parser struct
  mod.rs                  declarations + the #[allow]s for vendored code
src/tokenizer/            tokens/tokenize/errors copied from hydent-lang,
                          generated_tokenmap.rs from tibineko
src/compiler/, src/diagnostic/, src/utility/
                          arena, span, symbol, source holder, diagnostics
tests/parse.rs            integration tests
```

### Provenance

Of the 34 `.rs` files under `src/`:

| | Count | Which |
|---|---|---|
| **byte-identical to hydent-lang** | 17 | arena, span, symbol, source_holder, converter, diagnotice_patterns, stream, ast_node, base_parser, parser/diagnostic, parser/errors, recovery, token_stream, tokenizer/errors, tokenize, tokens, hashable_float |
| **modified** | 10 | the five `mod.rs` files, `lib.rs`, `parse.rs`, `manual_ast.rs`, `manual_parser.rs`, `tracer.rs` |
| **new** | 7 | `compiler/context.rs`, four `generated_*`, and the two test modules |

The modifications are mostly `mod` declarations and lint attributes. The two
substantive ones:

- `src/diagnostic/mod.rs` — adds `#[derive(Debug)]` to `Diagnostic` and
  `DiagnosticLevel`, which the tests need and hydent never did
  ([`../docs/gotchas.md`](../docs/gotchas.md) §3).
- `src/parser/tracer.rs` — drops two unused imports, matching `runtime/`.

## Tests

**Unit** (`cargo test --lib`, 16 tests — inside the crate so they can see
`pub(super)` fields):

`src/tokenizer/tests.rs` (6)
- `tokenizes_a_key_value_pair`, `tokenizes_string_and_bool_literals`,
  `tokenizes_brackets_and_parens`
- `tokenizer_produces_both_comment_kinds` — the tokenizer emits *both* comment
  kinds
- `token_stream_drops_line_comments_but_keeps_doc_comments` — filtering is
  `TokenStream`'s job, not the tokenizer's
- `reports_an_unknown_token`

`src/parser/tests.rs` (9)
- `parses_an_empty_document`, `parses_a_single_pair`, `parses_each_value_shape`
- `keeps_a_doc_comment_as_an_entry`
- `walks_boxed_recursive_values` — the `ArenaBox` cycle
- `parses_a_nested_list_and_ignores_a_trailing_comma`
- `recovers_and_keeps_parsing`, `rejects_garbage`
- `renders_json_with_type_names_as_keys` — guards the printer against silently
  drifting from the AST shape

`src/parser/ast_node.rs` (1)
- `invalid_token_marker_matches_every_non_eof_token` — ships with the runtime

**Integration** (`cargo test --test parse`, 9 tests — public API only, so they
also check the API is usable from outside):

- `parses_a_whole_document_without_diagnostics`
- `resolves_keys_through_the_symbol_table`
- `distinguishes_every_value_shape`
- `walks_a_deeply_nested_value`
- `renders_the_ast_as_json`
- `a_broken_tail_does_not_lose_what_came_before`
- `garbage_in_the_middle_still_yields_a_document`
- `an_empty_source_is_a_valid_empty_document`,
  `whitespace_only_source_is_also_empty`

The two recovery tests are deliberately asymmetric. Where the parser resumes
after a *mid-document* error depends on the synchronisation sets, so asserting
on later entries would test recovery internals rather than the contract — that
test only asserts the document survives. The broken-tail case is deterministic,
so it asserts on the entries that came before.

## The FIRST/FOLLOW warnings

Generation prints warnings like:

```
👀 WARNING: Tokens in both First and Follow sets: ... in Rule Value
```

Expected for repetition-heavy grammars; hydent-lang emits the same class. This
grammar produces one for **10 of its 13 rules** (`Entry`, `Pair`, `Value`,
`GroupedValue`, `ListValue`, `ValueItem`, `Note`, `NumberLiteral`,
`StringLiteral`, `BoolLiteral`) and none of them is nullable, so none is fatal. They mean a token can both
start and follow a rule, so the generated `repeat` needs its second-token
lookahead (`FIRST_2_SETS`) to decide whether to continue. They only become
fatal for a *nullable* rule, where two tokens genuinely cannot resolve the
choice — the analyzer throws in that case. See
[`../docs/grammar.md`](../docs/grammar.md).

## Verification

There is no `cargo` in the environment where this was written, so **CI is the
compiler**. `.github/workflows/ci.yml` builds the crate, runs both test suites,
and lints with clippy `-D warnings` plus rustfmt.

Run [`39779785541`](https://github.com/sonneko/tibineko/actions/runs/39779785541):
**25 passed, 0 failed**, all three jobs green.

Getting there took eight CI runs, and every failure was a real bug — a dropped
`use IParseErr`, an inner attribute placed after `use` statements, `Diagnostic`
lacking `Debug`, `ArenaIterReader::Item` being `&mut T`, a test aimed at the
wrong layer for comment filtering, and a `&mut` where a shared reference was
wanted. They are written up in [`../docs/gotchas.md`](../docs/gotchas.md).
