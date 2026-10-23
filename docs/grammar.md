# The grammar DSL

A `.tibineko` file is a flat list of rules. There is no header, no imports, and
no precedence declarations — the grammar describes the shape of the AST, and
the analyzer works out the rest.

```
<branch_rule>  ::= "branch"  <ident> "{" { <ident> [ "with" <string> ] } "}"
<product_rule> ::= "product" <ident> ( "{" { <product_item> [ "with" <string> ] } "}"
                                        | "with" <string> )
<product_item> ::= ( <ident> ":" <nonterminal> ) | <string>
<nonterminal>  ::= ( "*" | "?" )? <ident>
```

Identifiers match `[a-zA-Z_][a-zA-Z0-9_]*`. String literals are `"..."` with no
escapes. `branch`, `product` and `with` are keywords. `// line` and `/* block */`
comments are skipped by the lexer.

The authoritative copy of this grammar is the comment at the top of
[`gen/ast.ts`](../gen/ast.ts); the parser is [`gen/parse.ts`](../gen/parse.ts).

---

## `branch` → Rust `enum`

One variant per alternative, dispatched on the next token.

```
branch Value {
    NumberLiteral
    StringLiteral
    ListValue
}
```

```rust
pub enum Value {
    NumberLiteral(NumberLiteral),
    StringLiteral(StringLiteral),
    ListValue(ListValue),
}
```

A variant may carry a note:

```
branch Statement {
    If       with "the conditional form"
    Return
}
```

The note is stored on the IR node. Only one note value is special: a note
containing the substring `boxed` forces boxing (see below).

---

## `product` → Rust `struct`

Fields in order, plus terminals that are consumed and checked but not stored.

```
product Pair {
    key: Identifier
    ":"
    value: Value
    ";"
}
```

```rust
pub struct Pair {
    pub(super) key: Identifier,
    pub(super) value: Value,
}
```

A `product` with no body is a unit struct matched by a single terminal:

```
product Comma with ","
product Note  with "#doc_comment"
```

---

## Repetition and optionality

| Syntax | Rust type | Meaning |
|---|---|---|
| `T` | `T` | exactly one |
| `*T` | `ArenaIter<T>` | zero or more |
| `?T` | `Option<T>` | zero or one |

`*T` allocates a list in the arena and returns a handle to it, which is why
recursive rules that go through a list do not need boxing (below).

```
product ListValue {
    "["
    items: *ValueItem
    "]"
}

product ValueItem {
    value: Value
    comma: ?Comma
}
```

A trailing comma falls out of this shape for free: `ValueItem` optionally
consumes one, so `[1, 2,]` and `[1, 2]` parse to the same two items.

---

## Boxing

Rust types must have a known size, so a recursive cycle has to go through an
indirection. tibineko finds the cycles for you.

The analyzer (`analyze.ts:computeCycle`) builds the rule graph and marks inline
back-edges as boxed. **Edges through a `*list` are deliberately excluded** from
the graph, because `ArenaIter` is already a handle — boxing them would add an
indirection for nothing.

```
// Inline cycle: must be boxed, or the enum has infinite size.
//   Value -> GroupedValue -> Value
product GroupedValue {
    "("
    value: Value        // becomes ArenaBox<Value>
    ")"
}

// Cycle through a list: must NOT be boxed, ArenaIter is already a handle.
//   Value -> ListValue -> ValueItem -> Value
product ListValue {
    "["
    items: *ValueItem   // stays ArenaIter<ValueItem>
    "]"
}
```

Both cases appear in [`example/grammar.tibineko`](../example/grammar.tibineko),
and `example/tests/parse.rs::walks_a_deeply_nested_value` walks the boxed cycle
at runtime.

To force boxing on a field that the analyzer would leave inline, add
`with "boxed"`:

```
branch Expression {
    SubExpr with "boxed"
}
```

The check is a substring match on the note, so `with "boxed: recursive"` also
works.

---

## Terminals and the token map

Every string literal in the grammar must appear in the token map CSV, or
generation fails:

```
tokenmap: no token definition for literal "++"
```

Two literals are special: `#fallback` and `#raw_token` are *pseudo-terminals*.
They declare a hand-written parser hook and are excluded from the FIRST/FOLLOW
sets entirely. See [`token-map.md`](token-map.md).

---

## What the analyzer checks

Generation runs `analyze.ts`, which computes nullable rules, FIRST over token
*pairs*, FOLLOW, and the cycle graph, then checks the result is LL(2).

**Warning** — a token appears in both FIRST and FOLLOW of a rule:

```
👀 WARNING: Tokens in both First and Follow sets: ... in Rule Value
```

This is common and usually harmless in repetition-heavy grammars. It means a
token can both start and follow the rule, so the generated `repeat` needs its
second-token lookahead (`FIRST_2_SETS`) to decide whether to continue. The
analyzer sets `firstAndFollowConflict` on the affected rules, which is what
makes the generated code use the two-token path.

**Error** — the same overlap in a rule that is also *nullable*:

```
❌ LL(2) Conflict in Nullable Rule "X":
  Tokens in both First and Follow sets: ...
Grammar conflict
```

Two tokens genuinely cannot resolve the choice here, so generation stops. The
usual fix is to make the rule non-nullable, or to hoist the optional part into
its own rule.

`example/` prints the warning for 10 of its 13 rules and never the error —
that is the expected shape for a working grammar.

---

## Complete example

[`example/grammar.tibineko`](../example/grammar.tibineko) is 13 rules and
exercises every construct: `branch`, `product`, unit products, `*list`,
`?option`, both recursion cases, and five hand-written nodes.
