//! The frontend context, trimmed down from hydent-lang's.
//!
//! The generated parser never names this type; only `parser::parse` does. It
//! carries the three things generated code reaches for through `self.ctx`.

use crate::compiler::arena::Arena;
use crate::compiler::symbol::SymbolFactory;

pub struct CompilerFrontendContext<'ctx, 'src> {
    pub source: &'src str,
    pub symbol_factory: &'ctx mut SymbolFactory<'src>,
    pub ast_arena: &'ctx Arena,
}

impl<'ctx, 'src> CompilerFrontendContext<'ctx, 'src> {
    pub fn new(
        source: &'src str,
        ast_arena: &'ctx Arena,
        symbol_factory: &'ctx mut SymbolFactory<'src>,
    ) -> Self {
        Self {
            source,
            symbol_factory,
            ast_arena,
        }
    }
}
