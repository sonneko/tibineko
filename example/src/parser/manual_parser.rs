//! Implements the `GeneratedParser` hooks tibineko left abstract: one per
//! `$payload$` node in the grammar.

use crate::diagnostic::stream::DiagnosticStream;
use crate::parser::base_parser::BaseParser;
use crate::parser::generated_ast;
use crate::parser::generated_parser::GeneratedParser;
use crate::parser::parse::Parser;
use crate::parser::tracer::Tracer;
use crate::tokenizer::tokens::{Comment, Literal, Token};

impl<S: DiagnosticStream, TR: Tracer> GeneratedParser for Parser<'_, '_, '_, S, TR> {
    type TraceGuard = TR::Guard;

    fn trace(name: &'static str) -> TR::Guard {
        TR::trace(name)
    }

    fn parse_Identifier(&mut self) -> Result<generated_ast::Identifier, Self::Error> {
        if let Some(Token::Identifier(symbol)) = self.peek::<0>() {
            self.consume_token();
            Ok(generated_ast::Identifier { symbol })
        } else {
            Err(Self::Error::build(true, &[], self.enviroment()))
        }
    }

    fn parse_StringLiteral(&mut self) -> Result<generated_ast::StringLiteral, Self::Error> {
        if let Some(Token::Literal(Literal::StringLiteral(span))) = self.peek::<0>() {
            self.consume_token();
            Ok(generated_ast::StringLiteral { span })
        } else {
            Err(Self::Error::build(false, &[], self.enviroment()))
        }
    }

    fn parse_NumberLiteral(&mut self) -> Result<generated_ast::NumberLiteral, Self::Error> {
        if let Some(Token::Literal(Literal::IntegerLiteral(value))) = self.peek::<0>() {
            self.consume_token();
            Ok(generated_ast::NumberLiteral { value })
        } else {
            Err(Self::Error::build(false, &[], self.enviroment()))
        }
    }

    fn parse_BoolLiteral(&mut self) -> Result<generated_ast::BoolLiteral, Self::Error> {
        if let Some(Token::Literal(Literal::BoolLiteral(value))) = self.peek::<0>() {
            self.consume_token();
            Ok(generated_ast::BoolLiteral { value })
        } else {
            Err(Self::Error::build(false, &[], self.enviroment()))
        }
    }

    fn parse_Note(&mut self) -> Result<generated_ast::Note, Self::Error> {
        if let Some(Token::Comment(Comment::DocComment(span))) = self.peek::<0>() {
            self.consume_token();
            Ok(generated_ast::Note { span })
        } else {
            Err(Self::Error::build(false, &[], self.enviroment()))
        }
    }
}
