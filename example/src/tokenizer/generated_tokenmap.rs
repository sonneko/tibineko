#![allow(unused_imports)]
#![allow(clippy::match_single_binding)]
#![allow(clippy::zero_prefixed_literal)]

use phf::phf_map;
use crate::tokenizer::errors::TokenizeErrKind;
use crate::tokenizer::tokenize::Tokenizer;
use crate::tokenizer::tokens::{Token, Keyword, Operator, Delimiter};

pub static LONG_KEYWORDS_MAP: phf::Map<&'static [u8], Token> = phf_map!{
};

// Short word-like literals of any token kind, not just keywords:
// the tokenizer reads a whole identifier-shaped run and looks it up
// here, so a short custom token ("ab" -> Token::Foo) must be in this
// table or it can never be produced.
pub fn scan_short_keywords(literal: &[u8]) -> Token {
    match literal {
        _ => Token::Invalid,
    }
}

pub fn scan_operator_or_delimiter(tokenizer: &mut Tokenizer<'_, '_>) -> Result<Token, TokenizeErrKind> {
    let b = tokenizer.peek();
    match b {
    Some(b'(') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::LeftParen))
    }
    Some(b')') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::RightParen))
    }
    Some(b',') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::Comma))
    }
    Some(b':') => {
        tokenizer.advance();
        Ok(Token::Operator(Operator::Colon))
    }
    Some(b';') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::Semicolon))
    }
    Some(b'[') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::LeftBracket))
    }
    Some(b']') => {
        tokenizer.advance();
        Ok(Token::Delimiter(Delimiter::RightBracket))
    }
        _ => Err(TokenizeErrKind::UnknownToken),
    }
}
