use std::fmt::Display;

use crate::compiler::arena::{Arena, ArenaBox};
use crate::compiler::source_holder::SourceHolder;
use crate::compiler::symbol::SymbolFactory;
use crate::diagnostic::stream::StockDiagnosticStream;
use crate::diagnostic::Diagnostic;
use crate::parser::ast::ASTVisitor;
use crate::parser::generated_ast_printer::ASTPrinter;
use crate::parser::parse::Parser;
use crate::parser::tracer::NopeTracer;
use crate::tokenizer::tokenize::Tokenizer;

// --- tibineko runtime (copied; do not edit) -------------------------------
// The runtime modules below are T1: byte-identical copies from
// hydent-lang. Upstream is not clippy-clean under `-D warnings`, so the lints
// are silenced on the module declarations instead of by patching vendored code:
//   base_parser.rs:235  `optional`'s `parser_fn` does not need `mut`
//   errors.rs:26        `IParseErr::build`'s `identifier` is unused (upstream
//                       carries a `WARNING: identifier is ignored` comment)
//   tracer.rs:14        `NopeTracer::trace`'s `name` is unused
mod ast_node;
#[allow(unused_mut)]
mod base_parser;
#[allow(unused_variables)]
mod errors;
mod recovery;
pub mod token_stream;
#[allow(unused_variables)]
pub mod tracer;

// --- tibineko generated output (regenerate with `node gen.ts`) ------------
mod generated_ast;
mod generated_ast_printer;
mod generated_parser;

// --- hand-written for this language ---------------------------------------
mod manual_ast;
mod manual_parser;
pub mod parse;

mod diagnostic;

#[cfg(test)]
mod tests;

pub mod ast {
    pub use crate::parser::generated_ast::*;
}

/// A parsed document plus everything needed to render it back out.
pub struct Ast<'src> {
    ast: ArenaBox<generated_ast::Document>,
    ast_arena: Arena,
    symbols: SymbolFactory<'src>,
    source_holder: SourceHolder<'src>,
}

impl Display for Ast<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut printer = ASTPrinter {
            symbols: &self.symbols,
            arena: &self.ast_arena,
            source_holder: &self.source_holder,
            writer: f,
        };
        printer.visit_Document(self.ast.get(&self.ast_arena))
    }
}

impl<'src> Ast<'src> {
    /// The root node.
    pub fn document(&self) -> &generated_ast::Document {
        self.ast.get(&self.ast_arena)
    }

    pub fn arena(&self) -> &Arena {
        &self.ast_arena
    }

    pub fn symbols(&self) -> &SymbolFactory<'src> {
        &self.symbols
    }
}

/// Tokenizes and parses `source`, collecting diagnostics instead of panicking.
pub fn parse_source(source: &str) -> (Ast<'_>, Vec<Diagnostic>) {
    let mut diagnostic_stream = StockDiagnosticStream::new();
    let mut symbols = SymbolFactory::new(source);
    let tokenizer = Tokenizer::new(source, &mut symbols);
    let (tokens, line_starts) = tokenizer.tokenize(&mut diagnostic_stream);
    let stream = token_stream::TokenStream::new(tokens);
    let mut ast_arena = Arena::new();

    let mut parser: Parser<'_, '_, '_, _, NopeTracer> = Parser::new(
        stream,
        crate::compiler::context::CompilerFrontendContext::new(
            source,
            &mut ast_arena,
            &mut symbols,
        ),
        &mut diagnostic_stream,
    );
    let ast = parser.parse();

    let ast = Ast {
        ast,
        ast_arena,
        source_holder: SourceHolder::new(source, line_starts),
        symbols,
    };
    (ast, diagnostic_stream.into_vec())
}
