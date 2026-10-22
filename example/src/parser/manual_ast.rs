//! AST nodes the grammar declares with a `$payload$` token, so tibineko emits
//! `pub use crate::parser::manual_ast::X;` instead of generating a struct.
//!
//! The generated printer hard-codes two of these by name:
//!   * `Identifier`   -> reads `.symbol`
//!   * `StringLiteral`-> reads `.span`
//! That is a `TIBINEKO-FORK` point in `gen/gen_ast_printer.ts`.

use crate::compiler::{span::Span, symbol::Symbol};

#[derive(Debug, Copy, Clone, std::hash::Hash, PartialEq, Eq)]
pub struct Identifier {
    pub symbol: Symbol,
}

#[derive(Debug, Copy, Clone, std::hash::Hash, PartialEq, Eq)]
pub struct StringLiteral {
    pub span: Span,
}

#[derive(Debug, Copy, Clone, std::hash::Hash, PartialEq, Eq)]
pub struct NumberLiteral {
    pub value: i32,
}

#[derive(Debug, Copy, Clone, std::hash::Hash, PartialEq, Eq)]
pub struct BoolLiteral {
    pub value: bool,
}

/// A `///` doc comment, kept as an entry so the parser is lossless.
#[derive(Debug, Copy, Clone, std::hash::Hash, PartialEq, Eq)]
pub struct Note {
    pub span: Span,
}
