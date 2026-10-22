// ---------------------------------------------------------------------------
// Not a real module: these are the lines your `src/parser/mod.rs` must declare
// after copying `tibineko/runtime/*.rs` into `src/parser/`.
//
// The runtime uses `crate::parser::...` absolute paths, so the files have to
// land exactly there. That is the whole reason tibineko is vendored instead of
// published as a crate: `crate::` keeps resolving, and nothing needs to be
// generic over your `Token` or your arena.
// ---------------------------------------------------------------------------

// --- tibineko runtime (T1: copied, do not edit) ----------------------------
mod ast_node;
mod base_parser;
mod errors;
mod recovery;
mod tracer;
mod token_stream; // if you keep the reference token cursor

// --- tibineko generated output (commit these) -----------------------------
mod generated_ast;
mod generated_ast_printer;
mod generated_parser;

// --- yours (T3) -----------------------------------------------------------
mod manual_ast;    // hand-written AST nodes referenced by the grammar
mod manual_parser; // `impl GeneratedParser for Parser` hooks
mod parse;         // your `Parser` struct; see seed/parse.rs

pub mod ast {
    pub use crate::parser::generated_ast::*;
}

// ---------------------------------------------------------------------------
// The runtime expects you to provide these elsewhere in your crate:
//
//   crate::compiler::arena::{Arena, ArenaBox, ArenaIter}
//   crate::compiler::span::Span
//   crate::diagnostic::stream::DiagnosticStream
//   crate::tokenizer::tokens::{Token, Comment, Keyword, Operator, Delimiter}
//   crate::parser::generated_ast::ASTVisitor   (generated)
//   crate::parser::parse::Parser               (yours)
//
// `Token` must be an enum whose Keyword / Operator / Delimiter variants are
// `#[repr(u8)]` with fewer than 64 entries each: `TokenSet` stores them as
// u64 bitmasks. Raise TokenSet to u128 in your copy if you outgrow that.
// ---------------------------------------------------------------------------
