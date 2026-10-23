# `seed/` — files you copy once, then own

These are **T2**: tibineko hands them to you, and after the first copy they are
yours. Nothing here is ever overwritten by an update, so edit freely.

| File | Copy to | What it is |
|---|---|---|
| `gen.ts` | next to your grammar (e.g. `gen.ts` at the repo root) | your generator entry point |
| `parse.rs` | `src/parser/parse.rs` | your `Parser` struct |
| `parser_mod_snippet.rs` | — | **not a module.** The `mod` declarations to paste into `src/parser/mod.rs` |

---

## `gen.ts`

The only tibineko-related file you are expected to maintain. It fills in a
`TibinekoConfig` and calls `generate()`:

```bash
cp tibineko/seed/gen.ts ./gen.ts
# edit the four paths, then:
node gen.ts
```

The paths are the whole configuration. There is no config file schema and no
CLI flag parser — the type is `TibinekoConfig` in
[`gen/index.ts`](../gen/index.ts), and every field is documented there.

Two things worth knowing:

- `targets` is optional per key. Leave one out to skip that artifact — the AST
  size checker in particular is opt-in.
- `specDir`, if set, also writes `ast.json`, `ir.json` and a mermaid diagram.
  Useful while a grammar is in flux; `example/` writes it to `spec/` and
  gitignores it.

`example/gen.ts` is this file with `import.meta.url`-relative paths, which is
what you want if the generator runs from CI.

---

## `parse.rs`

Your `Parser` struct — the thing the generated `GeneratedParser` trait is
implemented for. The seed is hydent-lang's `Parser` verbatim, so the parts you
will most likely change are:

- **the context type.** It uses `CompilerFrontendContext`, which is not part of
  the runtime; you write your own. `example/src/compiler/context.rs` is a
  minimal one: `source`, `symbol_factory`, `ast_arena`.
- **`parse()`.** The entry point the generated `parse_Module` is reached from.
  The seed's version shows the shape that matters: on a failed root parse it
  still reports the error *and* returns an empty AST rather than throwing away
  everything, and after a successful one it checks for a trailing unexpected
  token without discarding the declarations parsed before it.
- **the root rule name.** `parse_Module` and `ArenaBox<Module>` are
  hydent-lang's; rename to your own root rule.

Note that `CompilerFrontendContext::new` takes `&Arena`, not `&mut Arena` — the
arena allocates through interior mutability.

---

## `parser_mod_snippet.rs`

Not compiled, not a module. It is the block of `mod` declarations your
`src/parser/mod.rs` needs after copying `tibineko/runtime/*.rs` into
`src/parser/`:

```rust
mod ast_node;
mod base_parser;
mod errors;
mod recovery;
mod tracer;
mod token_stream;      // if you keep the reference token cursor

mod generated_ast;
mod generated_ast_printer;
mod generated_parser;

mod manual_ast;
mod manual_parser;
mod parse;

pub mod ast {
    pub use crate::parser::generated_ast::*;
}
```

The runtime uses `crate::parser::...` absolute paths, so the files have to land
exactly there — that is the whole reason tibineko is vendored instead of
published as a crate.

`example/src/parser/mod.rs` is a real version of this, including the
`#[allow(...)]` attributes that keep the vendored runtime clippy-clean without
editing it. See [`docs/gotchas.md`](../docs/gotchas.md) §6.
