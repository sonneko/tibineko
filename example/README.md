# `example/` — a second language, as a real crate

A small config-file language. 13 grammar rules generate the parser, AST types,
printer and scanner tables; the rest of the crate is the tibineko runtime plus
the support modules they need.

```bash
node gen.ts        # regenerate the committed Rust from the grammar
cargo test         # unit tests + integration tests
```

## The grammar

```
Document     ::= Entry*
Entry        ::= Pair | Note
Pair         ::= Identifier ":" Value ";"
Value        ::= NumberLiteral | StringLiteral | BoolLiteral | ListValue | GroupedValue
ListValue    ::= "[" ValueItem* "]"
ValueItem    ::= Value ","?
GroupedValue ::= "(" Value ")"
Note         ::= doc comment
```

## What it exercises

| Construct | Rule | Why it matters |
|---|---|---|
| `branch` -> `enum` | `Entry`, `Value` | variant dispatch on `peek(0)` |
| `product` -> `struct` | `Pair`, `ValueItem` | field ordering, terminal matching |
| unit product | `Comma with ","` | single-terminal rule |
| `*list` -> `ArenaIter` | `Document.entries`, `ListValue.items` | repetition, FIRST/FOLLOW |
| `?option` -> `Option` | `ValueItem.comma` | nullable analysis |
| **inline recursion -> `ArenaBox`** | `Value -> GroupedValue -> Value` | must be boxed or the enum is infinitely sized |
| **recursion through a list** | `Value -> ListValue -> ValueItem -> Value` | must *not* be boxed; `ArenaIter` is already a handle |
| hand-written nodes | `Identifier`, `NumberLiteral`, `StringLiteral`, `BoolLiteral`, `Note` | the `$...$` path |
| **no keywords at all** | — | a language with an empty keyword set must not emit lint warnings |

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

## Layout

```
grammar.tibineko          yours
tokenmap.csv              yours
gen.ts                    yours (~20 lines)
src/parser/
  generated_*.rs          tibineko output, committed
  ast_node.rs base_parser.rs errors.rs recovery.rs tracer.rs token_stream.rs
                          tibineko runtime, copied
  manual_ast.rs           hand-written AST nodes (5)
  manual_parser.rs        hand-written parse hooks (5)
  parse.rs                the Parser struct
src/tokenizer/            tokens/tokenize/errors copied from hydent-lang,
                          generated_tokenmap.rs from tibineko
src/compiler/, src/diagnostic/, src/utility/
                          arena, span, symbol, source holder, diagnostics
tests/parse.rs            integration tests
```

The support modules are hydent-lang's, unchanged. Only `manual_ast.rs`,
`manual_parser.rs`, `parse.rs`, `compiler/context.rs` and the `mod.rs` files are
written for this language.

## Tests

**Unit** (`cargo test --lib`, inside the crate so they can see `pub(super)`
fields):

- `src/tokenizer/tests.rs` — tokenizing pairs, literals, brackets; doc comments
  survive while line comments are dropped; unknown tokens are reported.
- `src/parser/tests.rs` — empty document, single pair, every value shape, notes
  as entries, walking the boxed recursion, nested lists with a trailing comma,
  error recovery, garbage rejection, JSON rendering.
- `src/parser/ast_node.rs` — `TokenSet` bitmask semantics, including the `any`
  wildcard. These come with the runtime.

**Integration** (`cargo test --test parse`, public API only): a whole document
parses clean, keys resolve through the symbol table, every value shape is
distinguished, a deeply nested value is walked, the AST renders as JSON, error
recovery keeps the rest of the document, and empty input is a valid empty
document.

## The FIRST/FOLLOW warnings

Generation prints warnings like:

```
👀 WARNING: Tokens in both First and Follow sets: ... in Rule Value
```

Expected for repetition-heavy grammars; hydent-lang emits the same class. They
mean a token can both start and follow a rule, so the generated `repeat` needs
its second-token lookahead (`FIRST_2_SETS`) to decide whether to continue. They
only become fatal for a *nullable* rule, where two tokens genuinely cannot
resolve the choice — the analyzer throws in that case.

## Verification status

The generator side is verified locally: `node gen.ts` is deterministic and the
committed Rust matches it exactly.

The Rust side is verified by CI, not locally: there is no `cargo` in the
environment where this was written, so `.github/workflows/ci.yml` is the
compiler. It builds the crate, runs `cargo test --lib` (16 tests) and
`cargo test --test parse` (9 tests), and lints with clippy `-D warnings` plus
rustfmt. Run [`39779433721`](https://github.com/sonneko/tibineko/actions/runs/39779433721)
was the first fully green one — **25 passed, 0 failed**.

CI found real bugs that local review had missed: a dropped `use IParseErr`, an
inner attribute placed after `use` statements, `Diagnostic` lacking `Debug`,
and `ArenaIterReader::Item` being `&mut T` rather than `T`.
