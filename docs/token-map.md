# The token map

The token map is the bridge between the grammar's string literals and your
tokenizer's `Token` type. It is a CSV with one entry per literal:

```csv
"fn",        "Token::Keyword(Keyword::Fn)"
":",         "Token::Operator(Operator::Colon)"
"#int",      "Token::Literal(Literal::IntegerLiteral($i32$))"
"#fallback", "Token::Invalid"
```

Left column is the literal exactly as it appears in the grammar. Right column
is the **Rust expression** the generator emits for it — it is copied verbatim,
so it must be in scope wherever the generated code lands.

Every literal used by the grammar must have an entry, or generation fails:

```
tokenmap: no token definition for literal "++"
```

**Duplicate literals are an error:**

```
tokenmap: duplicate literal(s) "_"; later entries would silently win
```

This used to be silent. hydent-lang's `tokenmap.csv` has `"_"` on both line 89
and line 105, and last-one-wins hid it — which is why tibineko throws instead.

---

## `$...$` — payloads and hand-written nodes

A `$...$` span inside the token expression marks the token's payload type:

```csv
"#identifier", "Token::Identifier($Span$)"
"#int",         "Token::Literal(Literal::IntegerLiteral($i32$))"
"#bool",        "Token::Literal(Literal::BoolLiteral($bool$))"
```

Its presence has a second effect: **it marks the rule as hand-written.** A
`product` rule becomes hand-written when any of its terminals has a token
expression that either contains `$` or equals `Token::Invalid`
(`gen_parser.ts:184`). For those rules tibineko does *not* generate a body:

- `generated_ast.rs` emits `pub use crate::parser::manual_ast::X;` instead of a
  struct — you define `X`.
- `generated_parser.rs` emits `fn parse_X(&mut self) -> Result<X, Self::Error>;`
  with no body — you implement it in `manual_parser.rs`.

[`example/`](../example) has five such nodes:

| Node | Token expression | You provide |
|---|---|---|
| `Identifier` | `Token::Identifier($Span$)` | struct + `parse_Identifier` |
| `NumberLiteral` | `Token::Literal(Literal::IntegerLiteral($i32$))` | struct + `parse_NumberLiteral` |
| `StringLiteral` | `Token::Literal(Literal::StringLiteral($Span$))` | struct + `parse_StringLiteral` |
| `BoolLiteral` | `Token::Literal(Literal::BoolLiteral($bool$))` | struct + `parse_BoolLiteral` |
| `Note` | `Token::Comment(Comment::DocComment($Span$))` | struct + `parse_Note` |

The generated printer hard-codes two of these by name: `Identifier` is printed
through `.symbol` and `StringLiteral` through `.span`. Every other hand-written
node is printed with `format!("{:?}", node)`, so **your manual nodes must derive
`Debug`**. That hard-coding is a `TIBINEKO-FORK` point in
`gen/gen_ast_printer.ts`.

---

## `#` literals

A literal beginning with `#` is a convention, not real text — your tokenizer
decides what source produces it. Only two are special to the generator:

| Literal | Behaviour |
|---|---|
| `#fallback` | pseudo-terminal. Excluded from FIRST/FOLLOW; declares a hand-written hook. By convention maps to `Token::Invalid`, which also triggers the hand-written path. |
| `#raw_token` | same as `#fallback`, for lossless tokens. |
| anything else (`#identifier`, `#int`, `#string`, ...) | ordinary entry; carries a payload, so the rule becomes hand-written. |

`#fallback` and `#raw_token` are excluded from the FIRST/FOLLOW sets
(`analyze.ts:223`) precisely because they stand for "whatever the hand-written
parser wants to accept".

---

## What the generator emits

`gen_tokenmap.ts` turns the map into scanner tables in
`src/tokenizer/generated_tokenmap.rs`. The literals are split three ways:

| Output | Rule |
|---|---|
| `LONG_KEYWORDS_MAP` (`phf::Map<&[u8], Token>`) | literals **not** starting with `#` and length >= 5, sorted longest first |
| `scan_short_keywords(&[u8]) -> Token` | literals not starting with `#`, length < 5, whose token expression contains `Keyword` |
| `scan_operator_or_delimiter(&mut Tokenizer)` | a `match` on the next byte, walking a trie for multi-character operators |

Note that the length-5 split is on the *literal*, not on whether it is a
keyword — so a five-character operator lands in `LONG_KEYWORDS_MAP`. That is
harmless (it is keyed by byte string) but surprising on first read.

A language with no keywords at all emits an empty `phf_map!{}` and a
single-arm `match`. Both are legal Rust but trip clippy, so the generator
emits `#![allow(clippy::match_single_binding)]` and friends at the top of the
file. `example/` is exactly this case.

---

## Keeping `Token` in sync

`TokenSet` (in `runtime/ast_node.rs`) stores set membership as three `u64`
bitmasks indexed by `keyword as u8`, `operator as u8`, `delimiter as u8`:

```rust
Token::Keyword(keyword)   => keywords_bits   |= 1 << (keyword as u8),
Token::Operator(operator) => operators_bits  |= 1 << (operator as u8),
Token::Delimiter(delimiter) => delimiters_bits |= 1 << (delimiter as u8),
Token::Invalid            => any = true,
```

So the three enums must be `#[repr(u8)]`, have fewer than 64 variants each, and
**keep a stable order** — the bitmask in the generated parser and the scanner
tables are only in sync if the discriminants do not move. Reordering a variant
silently changes which tokens a rule accepts. Nothing checks this; it is the
one invariant tibineko cannot enforce for you.

Past 64 variants, widen `TokenSet` to `u128` in your copy.
