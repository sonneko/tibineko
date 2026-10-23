//! Unit tests for the tokenizer as configured by this language's token map.

use crate::compiler::symbol::SymbolFactory;
use crate::diagnostic::stream::StockDiagnosticStream;
use crate::parser::token_stream::TokenStream;
use crate::tokenizer::tokenize::Tokenizer;
use crate::tokenizer::tokens::{Comment, Delimiter, Literal, Operator, Token};

const SOURCE: &str = "/// kept\n// dropped\nkey: 1;";

fn tokenize(source: &str) -> (Vec<Token>, Vec<crate::diagnostic::Diagnostic>) {
    let mut symbols = SymbolFactory::new(source);
    let mut stream = StockDiagnosticStream::new();
    let (with_spans, _) = Tokenizer::new(source, &mut symbols).tokenize(&mut stream);
    (
        with_spans.into_iter().map(|(token, _)| token).collect(),
        stream.into_vec(),
    )
}

#[test]
fn tokenizes_a_key_value_pair() {
    let (tokens, diagnostics) = tokenize("port: 8080;");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );

    // Identifier, Colon, integer literal, Semicolon, EndOfFile.
    assert!(matches!(tokens[0], Token::Identifier(_)), "{:?}", tokens[0]);
    assert_eq!(tokens[1], Token::Operator(Operator::Colon));
    assert_eq!(tokens[2], Token::Literal(Literal::IntegerLiteral(8080)));
    assert_eq!(tokens[3], Token::Delimiter(Delimiter::Semicolon));
    assert_eq!(tokens[4], Token::EndOfFile);
}

#[test]
fn tokenizes_string_and_bool_literals() {
    let (tokens, diagnostics) = tokenize(r#"host: "localhost";"#);
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
    assert!(matches!(
        tokens[2],
        Token::Literal(Literal::StringLiteral(_))
    ));

    let (tokens, diagnostics) = tokenize("debug: true;");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
    assert_eq!(tokens[2], Token::Literal(Literal::BoolLiteral(true)));
}

#[test]
fn tokenizes_brackets_and_parens() {
    let (tokens, diagnostics) = tokenize("[1, (2)]");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
    // `[`(0) `1`(1) `,`(2) `(`(3) `2`(4) `)`(5) `]`(6) EOF(7)
    assert_eq!(tokens[0], Token::Delimiter(Delimiter::LeftBracket));
    assert_eq!(tokens[2], Token::Delimiter(Delimiter::Comma));
    assert_eq!(tokens[3], Token::Delimiter(Delimiter::LeftParen));
    assert_eq!(tokens[5], Token::Delimiter(Delimiter::RightParen));
    assert_eq!(tokens[6], Token::Delimiter(Delimiter::RightBracket));
    assert_eq!(tokens[7], Token::EndOfFile);
}

/// The tokenizer produces both comment kinds; it is `TokenStream` that drops
/// the ones the grammar cannot see. Testing the two layers separately keeps
/// that asymmetry pinned to the right place.
#[test]
fn tokenizer_produces_both_comment_kinds() {
    let (tokens, diagnostics) = tokenize("/// kept\n// dropped\nkey: 1;");
    assert!(
        diagnostics.is_empty(),
        "unexpected diagnostics: {diagnostics:?}"
    );
    assert!(
        tokens
            .iter()
            .any(|t| matches!(t, Token::Comment(Comment::DocComment(_)))),
        "doc comment should be produced: {tokens:?}"
    );
    assert!(
        tokens
            .iter()
            .any(|t| matches!(t, Token::Comment(Comment::LineComment))),
        "line comment should be produced: {tokens:?}"
    );
}

#[test]
fn token_stream_drops_line_comments_but_keeps_doc_comments() {
    let mut symbols = SymbolFactory::new(SOURCE);
    let mut stream = StockDiagnosticStream::new();
    let (with_spans, _) = Tokenizer::new(SOURCE, &mut symbols).tokenize(&mut stream);

    let kept: Vec<Token> = TokenStream::new(with_spans)
        .map(|(token, _)| token)
        .collect();

    assert!(
        kept.iter()
            .any(|t| matches!(t, Token::Comment(Comment::DocComment(_)))),
        "the grammar uses doc comments as `Note`, so they must survive: {kept:?}"
    );
    assert!(
        !kept
            .iter()
            .any(|t| matches!(t, Token::Comment(Comment::LineComment))),
        "line comments should be filtered out: {kept:?}"
    );
}

#[test]
fn reports_an_unknown_token() {
    let (_, diagnostics) = tokenize("key: 1; $");
    assert!(
        !diagnostics.is_empty(),
        "an unknown token should produce a diagnostic"
    );
}
