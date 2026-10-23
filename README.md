# tibineko

A recursive-descent parser generator. You describe a grammar in a small DSL,
tibineko emits Rust: the parser, the AST types, a visitor/printer, and scanner
tables.

**tibineko is not a package.** There is nothing to install, no registry entry,
no crate. You copy two directories into your repository and they become part of
your source tree — the way you would vendor `stb_image.h`, or the way Zig
treats `std`.

```
your-lang/
  tibineko/gen/       <- the generator (TypeScript, runs on plain node)
  tibineko/runtime/   <- the Rust runtime, copied into src/parser/
  assets/grammar.tibineko
  assets/tokenmap.csv
  gen.ts              <- your ~10 line entry point
```

Extracted from [hydent-lang](https://github.com/sonneko/hydent-lang) at
`bb9a359`. See [`plans.md`](plans.md) for why it was extracted this way.

## Documentation

| | |
|---|---|
| **This file** | what tibineko is, quick start, ownership tiers, updating, limits |
| [`docs/grammar.md`](docs/grammar.md) | the grammar DSL: full BNF, boxing, error messages |
| [`docs/token-map.md`](docs/token-map.md) | the token map, hand-written nodes, the tokenizer contract |
| [`docs/gotchas.md`](docs/gotchas.md) | traps when wiring the runtime into a new crate |
| [`gen/README.md`](gen/README.md) | generator internals and its API |
| [`runtime/README.md`](runtime/README.md) | the Rust runtime: what it provides, what you must provide |
| [`seed/README.md`](seed/README.md) | the files you copy once and then own |
| [`example/README.md`](example/README.md) | a complete second language, as a working crate |
| [`plans.md`](plans.md) | the extraction plan this repository was built from |

---

## Why vendoring, and not a crate

The generated parser is not a library you link against. It is a `trait` whose
default methods call each other recursively:

```rust
pub trait GeneratedParser: BaseParser + Sized {
    fn parse_BlockExpression(&mut self) -> Result<BlockExpression, Self::Error> { /* ... */ }
    // one per grammar rule
}
```

That trait, and the AST types it returns, are emitted with `crate::` absolute
paths and refer to *your* `Token`, *your* arena, *your* `Span`. Extracting it as
a crate would mean making all of that generic, which is exactly the coupling
that makes the generated parser fast and readable in the first place.

Vendoring sidesteps the problem entirely: the generated code lives inside your
crate, so `crate::` just resolves.

---

## Quick start

Node >= 22.6. Nothing else — no `npm install`, no `cargo` for generation.
Node strips the TypeScript types itself.

```bash
# 1. copy the generator
cp -r /path/to/tibineko/gen ./tibineko/gen

# 2. try it on the bundled example language
cd /path/to/tibineko/example && node gen.ts

# 3. run the generator's own tests
cd /path/to/tibineko && node gen/self_test.ts
```

Then write your entry point — see [`seed/gen.ts`](seed/gen.ts):

```ts
import { generate } from "./tibineko/gen/index.ts";

generate({
    grammar: "assets/grammar.tibineko",
    tokenMap: "assets/tokenmap.csv",
    targets: {
        parser:  "src/parser/generated_parser.rs",
        ast:     "src/parser/generated_ast.rs",
        printer: "src/parser/generated_ast_printer.rs",
        tokenMap:"src/tokenizer/generated_tokenmap.rs",
    },
    specDir: "out/spec/frontend",
    verbose: true,
});
```

There is deliberately no config file schema and no CLI flags. You own this
file; edit it however you like.

Then copy the runtime and wire it up:

```bash
cp tibineko/runtime/*.rs src/parser/
```

and add the `mod` declarations from
[`seed/parser_mod_snippet.rs`](seed/parser_mod_snippet.rs). Read
[`docs/gotchas.md`](docs/gotchas.md) first — there are five ways this step
fails that the compiler only reports one at a time.

---

## Layout and ownership

Three tiers. This is the only rule you need to remember.

| | What | On update |
|---|---|---|
| **T1** copy, do not edit | `gen/**`, `runtime/**` | overwrite |
| **T2** seed, then yours | `parse.rs`, `gen.ts` | manual merge |
| **T3** entirely yours | grammar, token map, `manual_ast.rs`, `manual_parser.rs`, `tokens.rs`, arena, span, diagnostics | tibineko never touches |

Keeping your edits inside T2/T3 is what makes updating cheap.

`example/` is the reference for how the tiers land in a real crate: of its 34
`.rs` files, **17 are byte-identical to hydent-lang's**, 10 are modified
(mostly `mod.rs` declarations), and 7 are generated or written for that
language. See [`example/README.md`](example/README.md).

### What the runtime needs from you

`runtime/*.rs` are copied **into `src/parser/`** (not a subdirectory) because
they use `crate::parser::...` paths. They expect you to provide:

```
crate::compiler::arena::{Arena, ArenaBox, ArenaIter}
crate::compiler::span::Span
crate::diagnostic::stream::DiagnosticStream
crate::tokenizer::tokens::{Token, Comment, Keyword, Operator, Delimiter}
crate::parser::generated_ast::ASTVisitor   (generated)
crate::parser::parse::Parser               (yours)
```

Full details in [`runtime/README.md`](runtime/README.md).

---

## The grammar DSL

```
<branch_rule>  ::= "branch"  <ident> "{" { <ident> [ "with" <string> ] } "}"
<product_rule> ::= "product" <ident> ( "{" { <product_item> [ "with" <string> ] } "}"
                                        | "with" <string> )
<product_item> ::= ( <ident> ":" <nonterminal> ) | <string>
<nonterminal>  ::= ( "*" | "?" )? <ident>
```

- `branch` becomes a Rust `enum`, one variant per alternative.
- `product` becomes a Rust `struct`; a `product X with "tok"` is a unit struct
  matched by a single terminal.
- `*T` is a repetition (`ArenaIter<T>`), `?T` is optional (`Option<T>`).
- Bare `"..."` members are terminals: consumed and checked, not stored.
- `with "boxed"` on a field forces `ArenaBox<T>`.
- `// line` and `/* block */` comments are skipped.

```
product Pair {
    key: Identifier
    ":"
    value: Value
    ";"
}
```

Recursion is handled for you: an inline cycle such as
`Value -> GroupedValue -> Value` is automatically boxed to `ArenaBox<Value>`,
otherwise the Rust type would have infinite size. A cycle through a `*list` is
*not* boxed, because `ArenaIter` is already a handle.

Full reference, with the boxing rules and the analyzer's error messages:
[`docs/grammar.md`](docs/grammar.md).

---

## The token map

A CSV mapping each grammar literal to the token expression to emit:

```csv
"fn",        "Token::Keyword(Keyword::Fn)"
":",         "Token::Operator(Operator::Colon)"
"#int",      "Token::Literal(Literal::IntegerLiteral($i32$))"
"#fallback", "Token::Invalid"
```

**Duplicate literals are an error** — tibineko throws rather than letting the
last one win silently.

`$...$` marks a payload type, and its presence also marks the node as
hand-written. Full reference: [`docs/token-map.md`](docs/token-map.md).

---

## Customizing

There is no plugin API. **Edit your copy.**

Every language-specific spot in the generator carries a `// TIBINEKO-FORK:`
comment, so after an update:

```bash
grep -rn 'TIBINEKO-FORK' tibineko/gen/
```

13 markers across 6 files. They cover the consumer's module paths, the `$...$`
handling, the `#fallback` / `#raw_token` pseudo-terminals, and the printer's
hand-coded node names.

---

## Updating

```bash
git subtree pull --prefix=tibineko https://github.com/sonneko/tibineko.git main --squash
grep -rn 'TIBINEKO-FORK' tibineko/gen/
```

T1 is overwritten wholesale; anything you changed there shows up as a conflict
or as a marker to re-apply.

---

## Limits

- **64 tokens per category.** `TokenSet` stores keyword / operator / delimiter
  membership as `u64` bitmasks, and relies on those enums being `#[repr(u8)]`
  with a stable order. Past 64, change `TokenSet` to `u128` in your copy.
- **LL(2).** The analyzer computes FIRST over token *pairs* and reports
  FIRST/FOLLOW overlap. It throws on a nullable rule whose FIRST meets its
  FOLLOW, since that cannot be resolved with two tokens of lookahead.
- **Generated code should be committed.** It is plain Rust; committing it means
  `cargo build` works without Node and the parser stays readable in a debugger.
  CI here asserts the committed output is never stale.

---

## Repository

| Path | What |
|---|---|
| `gen/` | the generator (15 files, 2674 lines). `node gen/self_test.ts` runs its tests. |
| `runtime/` | Rust runtime to copy into `src/parser/` (6 files, 680 lines). |
| `seed/` | files to copy once and then own. |
| `example/` | a small second language as a **real crate**, with generated output committed and tests. |
| `docs/` | grammar, token map, and gotcha references. |
| `.github/workflows/ci.yml` | three jobs: generator, example crate, lint. |
| `plans.md` | the extraction plan this repository was built from. |
| `VERSION` | `0.1.0`. |

---

## CI

`.github/workflows/ci.yml`, three required jobs.

| Job | Steps |
|---|---|
| **Generator** | assert no `package.json`/`node_modules` exist → `node gen/self_test.ts` → `node example/gen.ts` → `git diff --exit-code` on the four generated files |
| **Example crate** | `cargo build` → `cargo test --lib` → `cargo test --test parse` → `cargo test` |
| **Lint** | `cargo clippy --all-targets -- -D warnings` → `rustfmt --check` |

The generator job is what keeps the committed Rust honest: if the grammar
changes and nobody regenerates, `git diff` fails the build.

`rustfmt` skips the `generated_*` files (`skip_children=true`); reformatting
machine output by hand would be undone by the next `node gen.ts`. clippy's
`dead_code` / `unused_mut` / `unused_variables` are allowed on the *module
declarations* wrapping the vendored runtime, not inside it, so T1 stays
byte-identical to upstream.

Test counts are re-emitted as `::notice` annotations because this repository's
job logs are not reachable through the API.

---

## Verification status

**Generator** — verified locally on Node v22.22.3 with **no `node_modules`
present**:

- `gen/self_test.ts` — 16 passed, 0 failed.
- Feeding hydent-lang's grammar and token map to this `gen/` reproduces the
  original `tsx`-based pipeline's output. `generated_parser.rs` and
  `generated_ast_printer.rs` match **byte for byte**; `generated_ast.rs` and
  `generated_tokenmap.rs` differ only by the `#![allow(...)]` headers added
  here (verified by diffing against the pre-change generator, which does
  reproduce all four byte for byte).
- `example/gen.ts` is deterministic, and the committed Rust matches it exactly.

**Runtime** — 5 of the 6 `runtime/*.rs` files are byte-identical to
hydent-lang's working copies (`ast_node`, `base_parser`, `errors`, `recovery`,
`token_stream`). `tracer.rs` drops `use std::{fmt, io};` and
`use crate::compiler::span::Span;`, neither of which it uses — hydent masks
that with a crate-level `#![allow(unused)]`.

**Rust** — there is no `cargo` in the environment where this was written, so
**CI is the compiler**. Run
[`39779785541`](https://github.com/sonneko/tibineko/actions/runs/39779785541)
is green: build, **16 unit tests**, **9 integration tests** (25 passed, 0
failed), clippy `-D warnings`, and rustfmt.

CI found bugs that reading the code had missed — a dropped `use IParseErr`, an
inner attribute placed after `use` statements, `Diagnostic` lacking `Debug`,
and `ArenaIterReader::Item` being `&mut T` rather than `T`. They are written up
in [`docs/gotchas.md`](docs/gotchas.md).
