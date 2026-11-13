use crate::parser::base_parser::Enviroment;
use crate::tokenizer::tokens::Token;

#[derive(Clone, Copy, Debug)]
pub struct ParseErr {
    expected: &'static [Token],
    found: Enviroment,
    /// Whether an identifier was among the expected tokens. The generated
    /// parser and the hand-written parsers pass this in; diagnostics use
    /// it to say "expected an identifier" instead of naming a token list.
    identifier: bool,
}

impl ParseErr {
    pub fn expected(&self) -> &'static [Token] {
        self.expected
    }

    pub fn found(&self) -> Enviroment {
        self.found
    }

    pub fn expects_identifier(&self) -> bool {
        self.identifier
    }
}

pub trait IParseErr {
    fn build(identifier: bool, expected: &'static [Token], found: Enviroment) -> Self;
    fn is_endoffile_error(&self) -> bool;
}

impl IParseErr for ParseErr {
    fn build(identifier: bool, expected: &'static [Token], found: Enviroment) -> Self {
        Self {
            expected,
            found,
            identifier,
        }
    }

    fn is_endoffile_error(&self) -> bool {
        self.found.current == Token::EndOfFile
    }
}
