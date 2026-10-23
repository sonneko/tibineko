# Gotchas

Everything here was hit for real while wiring up
[`example/`](../example). There is no `cargo` in the environment where tibineko
was written, so CI was the first thing that compiled the result — it reported
these one at a time, over eight runs. Collecting them saves you the same loop.

---

## 1. `manual_parser.rs` needs `use IParseErr`

```
error[E0599]: no associated function or constant named `build` found for struct `ParseErr`
```

The generated hand-written hooks construct errors with `Self::Error::build(...)`:

```rust
Err(Self::Error::build(false, &[], self.enviroment()))
```

`build` is a method of the `IParseErr` *trait*, not of `ParseErr`, so it only
resolves when the trait is in scope. Import it:

```rust
use crate::parser::errors::IParseErr;
```

hydent-lang has `use crate::parser::errors::{IParseErr, ParseErr};` at
`manual_parser.rs:4`. It is easy to import just `ParseErr` and get five E0599s
pointing at generated code you did not write.

---

## 2. Inner attributes must come before every item

The generated files open with `#![allow(...)]`:

```rust
#![allow(unused_imports, unused_variables)]

use crate::compiler::arena::Arena;
```

An inner attribute (`#!`) placed *after* a `use` statement or any other item is
a hard error, not a warning. If you add an `#![allow(...)]` to a generated file
by hand, it goes above the first `use`. The generators emit theirs first for
this reason.

---

## 3. `Diagnostic` does not derive `Debug`

```
error[E0277]: `Diagnostic` doesn't implement `Debug`
```

hydent-lang prints diagnostics through `Display`, so it never needed `Debug`.
The moment you write the obvious test assertion —

```rust
assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
```

— it fails. Either add `#[derive(Debug)]` to `Diagnostic` and
`DiagnosticLevel` (`Highlight` and `Suggestion` already have it), or format
through `Display`.

`example/` adds the derives; that is the only change it makes to
`src/diagnostic/mod.rs`.

---

## 4. `ArenaIterReader::Item` is `&mut T`, not `T`

```
error[E0507]: cannot move out of index of `Vec<&mut Entry>`
error[E0596]: cannot borrow data in an index of `Vec<&mut Entry>` as mutable
```

`into_ref()` hands out mutable references:

```rust
impl<'a, T: Copy + 'static> Iterator for ArenaIterReader<'a, T> {
    type Item = &'a mut T;
```

Since AST nodes are `Copy`, the tidy fix is to copy at the point of collection:

```rust
let entries: Vec<Entry> = ast.document()
    .entries()
    .into_ref(ast.arena())
    .map(|e| *e)
    .collect();
```

---

## 5. `TokenStream` filters comments, not the tokenizer

A test asserting "line comments are dropped" against the tokenizer's output
fails, because the tokenizer produces them. `TokenStream::new` is what filters:

```rust
tokens.retain(|(token, _)| !matches!(
    token,
    Token::Comment(Comment::LineComment) | Token::Comment(Comment::BlockComment)
));
```

Note the asymmetry: a `Comment` variant you *do* want the parser to see must be
a different variant. hydent-lang's `DocComment` survives and becomes the
grammar's `Note` rule.

Test the two layers separately — it is a better test, and it pins the
asymmetry to the component responsible for it.

---

## 6. clippy and rustfmt disagree with vendored code

The runtime is a general-purpose library; a small consumer uses part of it.
Under `clippy -- -D warnings` that surfaces as `dead_code` for
`optional_box`, `TokenSet::union`, `is_sync_point` and friends, plus a few
`unused_mut` / `unused_variables` that upstream also has.

Silence them **on the module declarations**, not inside the vendored files, so
T1 stays byte-identical to upstream:

```rust
#[allow(unused_mut, dead_code)]
mod base_parser;
#[allow(unused_variables, dead_code)]
mod errors;
```

For rustfmt, exclude the generated files — but excluding them from the file
list is not enough, because **rustfmt follows `mod` declarations**. You need
`skip_children`:

```bash
rustfmt --edition 2021 --config skip_children=true --check $files
```

There is no `--skip-children` flag; it is a config option.

rustfmt's `chain_width` and `fn_call_width` are both **60**, not the 100 of
`max_width`, and they apply to the whole expression. That is why a 61-character
method chain gets broken and a 54-character one does not.

---

## 7. Upstream's typos are now tibineko's API

These are misspelled in hydent-lang and are deliberately left alone, because
renaming them would break every consumer's `impl` blocks:

| Name | Should be |
|---|---|
| `Enviroment` (struct in `base_parser.rs`) | `Environment` |
| `Analyzer::checkLL2Confilict` | `checkLL2Conflict` |
| `dublicateRemoved` (local in `gen_ast_type.ts`) | `duplicateRemoved` |

Write `self.enviroment()` and it will compile. Write `self.environment()` and
it will not.

---

## 8. Commit the generated code, and check it in CI

hydent-lang does not commit its `generated_*` files, but `src/parser/mod.rs`
declares them as modules — so a fresh clone cannot `cargo build` without
running Node first. tibineko commits them, and CI asserts they are current:

```yaml
- name: Committed generated sources are up to date
  run: git diff --exit-code -- example/src/parser/generated_ast.rs ...
```

Without that step, a grammar change and a forgotten `node gen.ts` produce a
crate that builds against yesterday's parser.

---

## 9. The `#[repr(u8)]` order invariant is unchecked

Reordering a variant in `Keyword`, `Operator` or `Delimiter` silently changes
which tokens a rule accepts, because `TokenSet` stores membership as bitmasks
indexed by the discriminant. Nothing detects this. See
[`token-map.md`](token-map.md#keeping-token-in-sync).

---

## 10. The IR has a `hook` kind that is never produced

`gen/ir.ts` declares `kind: "hook"` and four emitters branch on it
(`analyze.ts`, `gen_ast_type.ts`, `gen_parser.ts`, `gen_ast_printer.ts`), but no
code path ever creates one. Hand-written nodes go through the `$`/`Invalid`
terminal check instead. Dead branch, harmless, worth knowing before you go
looking for how to trigger it.
