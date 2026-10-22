// ---------------------------------------------------------------------------
// T2 seed: copy to src/parser/parse.rs and edit. After the first copy this
// file is yours; tibineko will never overwrite it.
//
// This is hydent-lang's Parser verbatim, so the parts you will most likely
// change are the context type (CompilerFrontendContext), the diagnostic
// stream, and `parse()`, which is the entry point the generated
// `parse_Module` is reached from.
//
// The generated code reaches you through `impl GeneratedParser for Parser`
// (see manual_parser.rs) -- that is where hand-written rules live.
// ---------------------------------------------------------------------------

use std::marker::PhantomData;

use crate::compiler::arena::ArenaBox;
use crate::compiler::context::frontend::CompilerFrontendContext;
use crate::diagnostic::stream::DiagnosticStream;
use crate::parser::base_parser::{BaseParser, Enviroment};
use crate::parser::errors::ParseErr;
use crate::parser::generated_ast::Module;
use crate::parser::generated_parser::GeneratedParser;
use crate::parser::tracer::Tracer;
use crate::tokenizer::token_stream::TokenStream;
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

    pub fn parse(&mut self) -> ArenaBox<Module> {
        match self.parse_Module() {
            Ok(module) => {
                if let Err(error) = self.expect(&Token::EndOfFile) {
                    // A recovered parse may still leave an unexpected token at
                    // the end. Report it without throwing away declarations
                    // that were successfully parsed before it.
                    self.report_error(error);
                }
                self.ctx.ast_arena.alloc(module)
            }
            Err(error) => {
                self.diagnostic_stream.pour(error, &self.enviroment());
                self.ctx.ast_arena.alloc(Module {
                    declarations: self.ctx.ast_arena.alloc_with(|| None),
                })
            }
        }
    }
}
