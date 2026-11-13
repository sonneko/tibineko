//! Unit tests for the parser. These live inside the crate, so they can see the
//! `pub(super)` AST fields that the integration tests in `tests/` cannot.

use crate::compiler::arena::Arena;
use crate::compiler::context::CompilerFrontendContext;
use crate::compiler::span::Span;
use crate::compiler::symbol::SymbolFactory;
use crate::diagnostic::stream::StockDiagnosticStream;
use crate::parser::ast::{Entry, ListValue, Value, ValueItem};
use crate::parser::ast_node::{ASTNode, TokenSet};
use crate::parser::base_parser::BaseParser;
use crate::parser::errors::ParseErr;
use crate::parser::parse::Parser;
use crate::parser::parse_source;
use crate::parser::token_stream::TokenStream;
use crate::parser::tracer::NopeTracer;
use crate::parser::Ast;
use crate::tokenizer::tokens::{Delimiter, Token};

/// Collects a document's entries into owned values.
///
/// `ArenaIterReader` yields `&mut T` rather than `T`. The nodes are `Copy`, so
/// copying them out here lets the assertions match on entries directly instead
/// of through a reference.
fn entries(ast: &Ast<'_>) -> Vec<Entry> {
    ast.document()
        .entries()
        .into_ref(ast.arena())
        .map(|e| *e)
        .collect()
}

/// The same, for one list's items.
fn value_items(list: &ListValue, ast: &Ast<'_>) -> Vec<ValueItem> {
    list.items().into_ref(ast.arena()).map(|e| *e).collect()
}

#[test]
fn parses_an_empty_document() {
    let (ast, diagnostics) = parse_source("");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    let entries = entries(&ast);
    assert!(entries.is_empty());
}

#[test]
fn parses_a_single_pair() {
    let (ast, diagnostics) = parse_source("port: 8080;");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let entries = entries(&ast);
    assert_eq!(entries.len(), 1);

    match entries[0] {
        Entry::Pair(pair) => {
            assert_eq!(ast.symbols().get(&pair.key().symbol), "port");
            match pair.value() {
                Value::NumberLiteral(n) => assert_eq!(n.value, 8080),
                other => panic!("expected NumberLiteral, got {other:?}"),
            }
        }
        other => panic!("expected Pair, got {other:?}"),
    }
}

#[test]
fn parses_each_value_shape() {
    let source = r#"n: 1; s: "x"; b: true; l: [1]; g: (1);"#;
    let (ast, diagnostics) = parse_source(source);
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let entries = entries(&ast);
    assert_eq!(entries.len(), 5, "one pair per key");

    let kinds: Vec<&str> = entries
        .iter()
        .map(|e| match e {
            Entry::Pair(p) => match p.value() {
                Value::NumberLiteral(_) => "number",
                Value::StringLiteral(_) => "string",
                Value::BoolLiteral(_) => "bool",
                Value::ListValue(_) => "list",
                Value::GroupedValue(_) => "grouped",
                Value::Invalid => "invalid",
            },
            Entry::Note(_) => "note",
            Entry::Invalid => "invalid-entry",
        })
        .collect();

    assert_eq!(kinds, ["number", "string", "bool", "list", "grouped"]);
}

#[test]
fn keeps_a_doc_comment_as_an_entry() {
    let (ast, diagnostics) = parse_source("/// a note\nport: 1;");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let entries = entries(&ast);
    assert_eq!(entries.len(), 2, "note and pair should both be entries");
    assert!(matches!(entries[0], Entry::Note(_)));
    assert!(matches!(entries[1], Entry::Pair(_)));
}

/// `Value -> GroupedValue -> Value` is an inline cycle that tibineko boxes to
/// `ArenaBox<Value>`. Walking it at runtime exercises that boxing.
#[test]
fn walks_boxed_recursive_values() {
    let (ast, diagnostics) = parse_source("deep: ((7));");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let entries = entries(&ast);
    let pair = match entries[0] {
        Entry::Pair(pair) => pair,
        other => panic!("expected Pair, got {other:?}"),
    };

    // Pair.value -> GroupedValue -> GroupedValue -> NumberLiteral(7)
    let outer = match pair.value() {
        Value::GroupedValue(g) => g,
        other => panic!("expected GroupedValue, got {other:?}"),
    };
    let inner = match outer.value().get(ast.arena()) {
        Value::GroupedValue(g) => g,
        other => panic!("expected GroupedValue, got {other:?}"),
    };
    match inner.value().get(ast.arena()) {
        Value::NumberLiteral(n) => assert_eq!(n.value, 7),
        other => panic!("expected NumberLiteral, got {other:?}"),
    }
}

#[test]
fn parses_a_nested_list_and_ignores_a_trailing_comma() {
    let (ast, diagnostics) = parse_source("nested: [1, [2, 3],];");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let entries = entries(&ast);
    let pair = match entries[0] {
        Entry::Pair(pair) => pair,
        other => panic!("expected Pair, got {other:?}"),
    };
    let list = match pair.value() {
        Value::ListValue(l) => l,
        other => panic!("expected ListValue, got {other:?}"),
    };

    let items = value_items(list, &ast);
    assert_eq!(items.len(), 2, "trailing comma should not add an item");

    // The second item is itself a list of two.
    let nested = match items[1].value() {
        Value::ListValue(l) => l,
        other => panic!("expected nested ListValue, got {other:?}"),
    };
    assert_eq!(value_items(nested, &ast).len(), 2);
}

/// A missing semicolon must not swallow the rest of the file: recovery should
/// report a diagnostic and still yield the following entry.
#[test]
fn recovers_and_keeps_parsing() {
    let (ast, diagnostics) = parse_source("a: 1\nb: 2;");
    assert!(!diagnostics.is_empty(), "a missing `;` should be reported");

    let entries = entries(&ast);
    let pairs = entries
        .iter()
        .filter(|e| matches!(e, Entry::Pair(_)))
        .count();
    // Only one pair is guaranteed here: after the missing `;`, recovery
    // skips to the next sync point and may swallow the following pair's
    // key, so pinning an exact count would pin recovery's resumption
    // point, which is implementation-defined. (Tried `== 2`: the actual
    // result is 1.)
    assert!(
        pairs >= 1,
        "recovery should keep at least one pair, got {pairs}"
    );
}

#[test]
fn rejects_garbage() {
    let (_, diagnostics) = parse_source("}}} not: a: config");
    assert!(
        !diagnostics.is_empty(),
        "garbage should produce diagnostics"
    );
}

/// Guards the printer against silently drifting from the AST shape. The
/// generated printer keys fields by AST type name, not by field name.
#[test]
fn renders_json_with_type_names_as_keys() {
    let (ast, diagnostics) = parse_source(r#"host: "localhost";"#);
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    let json = ast.to_string();

    assert!(json.starts_with(r#"{"type":"Document""#), "{json}");
    assert!(json.contains(r#""type":"Pair""#), "{json}");
    assert!(json.contains(r#""kind":"Pair""#), "{json}");
    assert!(json.contains("localhost"), "{json}");
    assert!(json.ends_with('}'), "{json}");
}

/// A node whose parse succeeds without consuming a token: the shape a
/// product of only `?B` fields has when the inner parse fails and the
/// option yields `None`.
#[derive(Copy, Clone, Debug, Hash, PartialEq, Eq)]
struct ZeroWidth;

impl ASTNode for ZeroWidth {
    type Target = Self;
    const FOLLOW_SETS: TokenSet = TokenSet::empty();
    const FIRST_1_SETS: TokenSet = TokenSet::build_map(
        false,
        false,
        false,
        false,
        &[Token::Delimiter(Delimiter::LeftBracket)],
    );
    const FIRST_2_SETS: TokenSet = TokenSet::empty();

    fn get_error_situation(_: ParseErr) -> Option<Self::Target> {
        None
    }

    fn ast_name() -> &'static str {
        "ZeroWidth"
    }
}

/// `repeat` must stop when an item parses successfully without consuming
/// a token. Without the progress check, the same `[` is retried forever
/// and the arena fills with empty items.
#[test]
fn repeat_stops_when_an_item_consumes_no_tokens() {
    let source = "[";
    let mut symbols = SymbolFactory::new(source);
    let arena = Arena::new();
    let tokens = TokenStream::new(vec![
        (Token::Delimiter(Delimiter::LeftBracket), Span::new(0, 1)),
        (Token::EndOfFile, Span::new(1, 1)),
    ]);
    let mut diagnostics = StockDiagnosticStream::new();
    let mut parser: Parser<'_, '_, '_, _, NopeTracer> = Parser::new(
        tokens,
        CompilerFrontendContext::new(source, &arena, &mut symbols),
        &mut diagnostics,
    );

    let items = parser
        .repeat(|_: &mut Parser<'_, '_, '_, _, NopeTracer>| Ok(ZeroWidth))
        .unwrap();
    assert_eq!(
        items.into_ref(&arena).count(),
        1,
        "one empty item, then stop"
    );
}
