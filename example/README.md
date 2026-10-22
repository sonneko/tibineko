# `example/` — a second language

A small config-file language, included to prove tibineko is not
hydent-lang-specific. 13 grammar rules produce 802 lines of Rust.

```bash
node gen.ts
```

Regenerating is deterministic: repeated runs produce byte-identical output, so
the committed `generated/` directory doubles as a snapshot test.

## The grammar

```
Document  ::= Entry*
Entry     ::= Pair | Note
Pair      ::= Identifier ":" Value ";"
Value     ::= NumberLiteral | StringLiteral | BoolLiteral | ListValue | GroupedValue
ListValue ::= "[" ValueItem* "]"
ValueItem ::= Value ","?
GroupedValue ::= "(" Value ")"
```

## What it exercises

| Construct | Rule | Why it matters |
|---|---|---|
| `branch` -> `enum` | `Entry`, `Value` | variant dispatch on `peek(0)` |
| `product` -> `struct` | `Pair`, `ValueItem` | field ordering, terminal matching |
| unit product | `Comma with ","` | single-terminal rule |
| `*list` -> `ArenaIter` | `Document.entries`, `ListValue.items` | repetition and its FIRST/FOLLOW handling |
| `?option` -> `Option` | `ValueItem.comma` | nullable analysis |
| **inline recursion -> `ArenaBox`** | `Value -> GroupedValue -> Value` | must be boxed or the Rust enum is infinitely sized |
| **recursion through a list** | `Value -> ListValue -> ValueItem -> Value` | must *not* be boxed, since `ArenaIter` is already a handle |
| hand-written nodes | `Identifier`, `NumberLiteral`, `StringLiteral`, `BoolLiteral`, `Note` | the `$...$` path: `pub use crate::parser::manual_ast::X;` |

The two recursion cases are the interesting pair. Look at
`generated/generated_ast.rs`:

```rust
pub struct GroupedValue {
    pub(super) value: ArenaBox<Value>,   // boxed: inline cycle
    ...
}

pub struct ListValue {
    pub(super) items: ArenaIter<ValueItem>,  // not boxed: list is a handle
}
```

And the generated dispatch stays readable:

```rust
fn parse_Value(&mut self) -> Result<Value, Self::Error> {
    match self.peek::<0>() {
        Some(Token::Literal(Literal::BoolLiteral(_)))   => Ok(Value::BoolLiteral(self.parse_BoolLiteral()?)),
        Some(Token::Delimiter(Delimiter::LeftParen))    => Ok(Value::GroupedValue(self.parse_GroupedValue()?)),
        Some(Token::Delimiter(Delimiter::LeftBracket))  => Ok(Value::ListValue(self.parse_ListValue()?)),
        ...
    }
}
```

## What this example is *not*

It is not a compilable crate. `example/generated/*.rs` refer to
`crate::parser::manual_ast`, `crate::compiler::arena` and so on, which do not
exist here — this directory has no `Cargo.toml` and no `src/`. It demonstrates
generation only.

Wiring it into a real crate means supplying the runtime's requirements (see
`../runtime/README.md`) plus the five hand-written nodes listed above. That
step has not been done, and no `cargo build` has been run anywhere in this
repository.

## The FIRST/FOLLOW warnings

Generation prints warnings such as:

```
👀 WARNING: Tokens in both First and Follow sets: ... in Rule Value
```

These are expected for repetition-heavy grammars and are the same class of
warning hydent-lang emits. They mean a token can both start and follow a rule,
so the generated `repeat` needs its second-token lookahead (`FIRST_2_SETS`) to
decide whether to continue. They only become fatal for a *nullable* rule, where
two tokens of lookahead genuinely cannot resolve the choice — the analyzer
throws in that case.
