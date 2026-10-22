//! End-to-end tests: source text in, AST and rendered JSON out.
//!
//! These use only the crate's public API, so they also check that the API is
//! actually usable from outside.

use tibineko_example::parser::ast::{Entry, ListValue, Value, ValueItem};
use tibineko_example::parser::parse_source;
use tibineko_example::parser::Ast;

const DOCUMENT: &str = r#"
/// server settings
host: "localhost";
port: 8080;
debug: true;
tags: ["a", "b",];
nested: [1, [2, 3], (4)];
"#;

/// Collects a parsed document's entries into owned values.
///
/// `ArenaIterReader` yields `&mut T` rather than `T`; the nodes are `Copy`, so
/// copying them out here keeps the assertions free of references.
fn entries_of(ast: &Ast<'_>) -> Vec<Entry> {
    ast.document()
        .entries()
        .into_ref(ast.arena())
        .map(|e| *e)
        .collect()
}

fn entries(source: &str) -> Vec<Entry> {
    let (ast, _) = parse_source(source);
    entries_of(&ast)
}

/// The same, for one list's items.
fn items_of(list: &ListValue, ast: &Ast<'_>) -> Vec<ValueItem> {
    list.items().into_ref(ast.arena()).map(|e| *e).collect()
}

#[test]
fn parses_a_whole_document_without_diagnostics() {
    let (ast, diagnostics) = parse_source(DOCUMENT);
    assert!(
        diagnostics.is_empty(),
        "expected a clean parse, got: {diagnostics:?}"
    );

    // One note plus five key/value pairs.
    let parsed = entries_of(&ast);
    assert_eq!(parsed.len(), 6, "note + 5 pairs");

    let notes = parsed
        .iter()
        .filter(|e| matches!(e, Entry::Note(_)))
        .count();
    let pairs = parsed
        .iter()
        .filter(|e| matches!(e, Entry::Pair(_)))
        .count();
    assert_eq!((notes, pairs), (1, 5));
}

#[test]
fn resolves_keys_through_the_symbol_table() {
    let (ast, diagnostics) = parse_source(DOCUMENT);
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");

    let mut keys = Vec::new();
    for entry in entries_of(&ast) {
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

    let parsed = entries_of(&ast);
    let pair = match parsed[0] {
        Entry::Pair(pair) => pair,
        other => panic!("expected Pair, got {other:?}"),
    };
    let list = match pair.value() {
        Value::ListValue(l) => l,
        other => panic!("expected ListValue, got {other:?}"),
    };

    let items = items_of(list, &ast);
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
    assert!(
        json.starts_with(r#"{"type":"Document","Entry":["#),
        "{json}"
    );
    assert!(json.contains(r#""type":"Pair","Identifier""#), "{json}");
    assert!(json.contains(r#""kind":"Pair""#), "{json}");
    assert!(json.contains(r#""kind":"Note""#), "{json}");
    assert!(json.contains("localhost"), "{json}");
    assert!(json.contains(r#""type":"ListValue""#), "{json}");
    assert!(json.contains(r#""type":"GroupedValue""#), "{json}");
    assert!(json.ends_with("]}"), "{json}");
}

/// Error recovery is the behaviour most likely to regress, so pin it: a broken
/// tail must produce a diagnostic *and* leave everything before it intact.
///
/// The failure is placed at the end of the input on purpose. Where recovery
/// resumes after a mid-document error depends on the synchronisation sets, so
/// asserting on later entries would be asserting on recovery internals rather
/// than on the contract.
#[test]
fn a_broken_tail_does_not_lose_what_came_before() {
    let (ast, diagnostics) = parse_source("good: 1;\nalso_good: 2;\ntruncated: ");
    assert!(
        !diagnostics.is_empty(),
        "the truncated pair should be reported"
    );

    let keys: Vec<String> = ast
        .document()
        .entries()
        .into_ref(ast.arena())
        .map(|e| *e)
        .filter_map(|e| match e {
            Entry::Pair(p) => Some(ast.symbols().get(&p.key().symbol).to_owned()),
            _ => None,
        })
        .collect();

    assert!(keys.contains(&"good".to_owned()), "lost `good`: {keys:?}");
    assert!(
        keys.contains(&"also_good".to_owned()),
        "lost `also_good`: {keys:?}"
    );
}

/// Mid-document garbage must not abort the parse. Where recovery resumes is an
/// implementation detail, so this only asserts that the document survives.
#[test]
fn garbage_in_the_middle_still_yields_a_document() {
    let (ast, diagnostics) = parse_source("a: 1;\n}}} nonsense\nb: 2;");
    assert!(!diagnostics.is_empty(), "garbage should be reported");

    let pairs = ast
        .document()
        .entries()
        .into_ref(ast.arena())
        .map(|e| *e)
        .filter(|e| matches!(e, Entry::Pair(_)))
        .count();
    assert!(
        pairs >= 1,
        "the document should not be empty: {pairs} pairs"
    );
}

#[test]
fn an_empty_source_is_a_valid_empty_document() {
    let (ast, diagnostics) = parse_source("");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    assert!(entries_of(&ast).is_empty());
    assert_eq!(ast.to_string(), r#"{"type":"Document","Entry":[]}"#);
}

#[test]
fn whitespace_only_source_is_also_empty() {
    let (ast, diagnostics) = parse_source("  \n\t\n  ");
    assert!(diagnostics.is_empty(), "unexpected: {diagnostics:?}");
    assert!(entries_of(&ast).is_empty());
}
