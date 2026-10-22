//! The parser struct. Seeded from `tibineko/seed/parse.rs`; this copy points at
//! this language's root rule (`Document`) and context type.

use std::marker::PhantomData;

use crate::compiler::arena::ArenaBox;
use crate::compiler::context::CompilerFrontendContext;
use crate::diagnostic::stream::DiagnosticStream;
use crate::parser::base_parser::{BaseParser, Enviroment};
use crate::parser::errors::ParseErr;
use crate::parser::generated_ast::Document;
use crate::parser::generated_parser::GeneratedParser;
use crate::parser::token_stream::TokenStream;
use crate::parser::tracer::Tracer;
use crate::tokenizer::tokens::Token;

pub struct Parser<'ctx, 'src, 's, S: DiagnosticStream, TR: Tracer> {
    pub ctx: CompilerFrontendContext<'ctx, 'src>,
    pub tokens: TokenStream,
    pub diagnostic_stream: &'s mut S,
    pub(super) deferred_diagnostics: Vec<(ParseErr, Enviroment)>,
    _marker: PhantomData<TR>,
    pub is_panic_or_backtrack_mode: bool,
}

impl<'ctx, 'src, 's, S: DiagnosticStream, TR: Tracer> Parser<'ctx, 'src, 's, S, TR> {
    pub fn new(
        tokens: TokenStream,
        ctx: CompilerFrontendContext<'ctx, 'src>,
        diagnostic_stream: &'s mut S,
    ) -> Parser<'ctx, 'src, 's, S, TR> {
        Self {
            ctx,
            tokens,
            diagnostic_stream,
            deferred_diagnostics: Vec::new(),
            _marker: PhantomData,
            is_panic_or_backtrack_mode: false,
        }
    }

    pub fn parse(&mut self) -> ArenaBox<Document> {
        match self.parse_Document() {
            Ok(document) => {
                if let Err(error) = self.expect(&Token::EndOfFile) {
                    // A recovered parse can still leave a stray token at the
                    // end. Report it without discarding what parsed cleanly.
                    self.report_error(error);
                }
                self.ctx.ast_arena.alloc(document)
            }
            Err(error) => {
                self.diagnostic_stream.pour(error, &self.enviroment());
                self.ctx.ast_arena.alloc(Document {
                    entries: self.ctx.ast_arena.alloc_with(|| None),
                })
            }
        }
    }
}
