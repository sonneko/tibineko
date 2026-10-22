//! End-to-end tests: source text in, AST and rendered JSON out.
//!
//! These use only the crate's public API, so they also check that the API is
//! actually usable from outside.

use tibineko_example::parser::ast::{Entry, Value};
use tibineko_example::parser::parse_source;

const DOCUMENT: &str = r#"
/// server settings
host: "localhost";
port: 8080;
debug: true;
tags: ["a", "b",];
nested: [1, [2, 3], (4)];
"#;

fn entries(source: &str) -> Vec<Entry> {
    let (ast, _) = parse_source(source);
    ast.document().entries().into_ref(ast.arena()).collect()
}

#[test]
fn parses_a_whole_document_without_diagnostics() {
    let (ast, diagnostics) = parse_source(DOCUMENT);
    assert!(
        diagnostics.is_empty(),
        "expected a clean parse, got: {diagnostics:?}"
    );

    // One note plus five key/value pairs.
    let parsed = ast.document().entries().into_ref(ast.arena()).collect::<Vec<_>>();
    assert_eq!(parsed.len(), 6, "note + 5 pairs");

    let notes = parsed.iter().filter(|e| matches!(e, Entry::Note(_))).count();
    let pairs = parsed.iter().filter(|e| matches!(e, Entry::Pair(_))).count();
    assert_eq!((notes, pairs), (1, 5));
}

#[test]
fn resolves_keys_through_the_symbol_table() {
    let (ast, diagnostics) = parse_source(DOCUMENT);
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let mut keys = Vec::new();
    for entry in ast.document().entries().into_ref(ast.arena()) {
        if let Entry::Pair(pair) = entry {
            keys.push(ast.symbols().get(&pair.key().symbol).to_owned());
        }
    }
    assert_eq!(keys, ["host", "port", "debug", "tags", "nested"]);
}

#[test]
fn distinguishes_every_value_shape() {
    let parsed = entries(DOCUMENT);
    let shapes: Vec<&str> = parsed
        .iter()
        .filter_map(|e| match e {
            Entry::Pair(p) => Some(match p.value() {
                Value::StringLiteral(_) => "string",
                Value::NumberLiteral(_) => "number",
                Value::BoolLiteral(_) => "bool",
                Value::ListValue(_) => "list",
                Value::GroupedValue(_) => "grouped",
                Value::Invalid => "invalid",
            }),
            _ => None,
        })
        .collect();

    assert_eq!(shapes, ["string", "number", "bool", "list", "list"]);
}

#[test]
fn walks_a_deeply_nested_value() {
    let (ast, diagnostics) = parse_source("nested: [1, [2, 3], (4)];");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let parsed = ast.document().entries().into_ref(ast.arena()).collect::<Vec<_>>();
    let pair = match parsed[0] {
        Entry::Pair(pair) => pair,
        other => panic!("expected Pair, got {other:?}"),
    };
    let list = match pair.value() {
        Value::ListValue(l) => l,
        other => panic!("expected ListValue, got {other:?}"),
    };

    let items = list.items().into_ref(ast.arena()).collect::<Vec<_>>();
    assert_eq!(items.len(), 3);

    // items[2] is a GroupedValue wrapping NumberLiteral(4) -- the boxed cycle.
    let grouped = match items[2].value() {
        Value::GroupedValue(g) => g,
        other => panic!("expected GroupedValue, got {other:?}"),
    };
    match grouped.value().get(ast.arena()) {
        Value::NumberLiteral(n) => assert_eq!(n.value, 4),
        other => panic!("expected NumberLiteral, got {other:?}"),
    }
}

#[test]
fn renders_the_ast_as_json() {
    let (ast, diagnostics) = parse_source(DOCUMENT);
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    let json = ast.to_string();

    // Keys are AST type names, not grammar field names.
    assert!(json.starts_with(r#"{"type":"Document","Entry":["#), "{json}");
    assert!(json.contains(r#""type":"Pair","Identifier""#), "{json}");
    assert!(json.contains(r#""kind":"Pair""#), "{json}");
    assert!(json.contains(r#""kind":"Note""#), "{json}");
    assert!(json.contains("localhost"), "{json}");
    assert!(json.contains(r#""type":"ListValue""#), "{json}");
    assert!(json.contains(r#""type":"GroupedValue""#), "{json}");
    assert!(json.ends_with("]}"), "{json}");
}

/// Error recovery is the behaviour most likely to regress, so pin it: a broken
/// line must produce a diagnostic *and* leave the rest of the document usable.
#[test]
fn recovers_from_errors_without_losing_the_rest() {
    let (ast, diagnostics) = parse_source("good: 1;\nbroken: \nalso_good: 2;");
    assert!(!diagnostics.is_empty(), "the broken line should be reported");

    let keys: Vec<String> = ast
        .document()
        .entries()
        .into_ref(ast.arena())
        .filter_map(|e| match e {
            Entry::Pair(p) => Some(ast.symbols().get(&p.key().symbol).to_owned()),
            _ => None,
        })
        .collect();

    assert!(keys.contains(&"good".to_owned()), "lost `good`: {keys:?}");
    assert!(
        keys.contains(&"also_good".to_owned()),
        "recovery did not reach `also_good`: {keys:?}"
    );
}

#[test]
fn an_empty_source_is_a_valid_empty_document() {
    let (ast, diagnostics) = parse_source("");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    assert!(ast.document().entries().into_ref(ast.arena()).next().is_none());
    assert_eq!(ast.to_string(), r#"{"type":"Document","Entry":[]}"#);
}

#[test]
fn whitespace_only_source_is_also_empty() {
    let (ast, diagnostics) = parse_source("  \n\t\n  ");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    assert!(ast.document().entries().into_ref(ast.arena()).next().is_none());
}
