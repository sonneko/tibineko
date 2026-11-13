use crate::{compiler::span::Span, tokenizer::tokens::Token};

pub struct TokenStream {
    tokens: Vec<(Token, Span)>,
    cursor: usize,
    checkpoints: Vec<usize>,
}

impl TokenStream {
    pub fn new(mut tokens: Vec<(Token, Span)>) -> Self {
        tokens.retain(|(token, _)| {
            !matches!(
                token,
                Token::Comment(crate::tokenizer::tokens::Comment::LineComment)
                    | Token::Comment(crate::tokenizer::tokens::Comment::BlockComment)
            )
        });
        Self {
            tokens,
            cursor: 0,
            checkpoints: Vec::with_capacity(10),
        }
    }

    pub fn peek(&self, index: usize) -> Option<(Token, Span)> {
        self.tokens.get(self.cursor + index).copied()
    }

    pub fn checkpoint(&mut self) {
        self.checkpoints.push(self.cursor);
    }

    pub fn rollback(&mut self) {
        // A rollback with no checkpoint is a no-op rather than a panic:
        // backtracking code only rolls back a checkpoint it took, and a
        // missing one means the speculative parse never started.
        if let Some(cursor) = self.checkpoints.pop() {
            self.cursor = cursor;
        }
    }

    pub fn commit(&mut self) {
        self.checkpoints.pop();
    }

    pub fn is_eof(&self) -> bool {
        self.cursor >= self.tokens.len()
    }

    pub fn get_now_span(&self) -> Span {
        // An empty stream has no last token to fall back to; report the
        // empty span at the start of the file instead of panicking.
        // (Span::new is part of the contract: every consumer tokenizer
        // already constructs spans that way.)
        self.tokens
            .get(self.cursor)
            .map(|(_, span)| *span)
            .or_else(|| self.tokens.last().map(|(_, span)| *span))
            .unwrap_or_else(|| Span::new(0, 0))
    }
}

impl std::iter::Iterator for TokenStream {
    type Item = (Token, Span);

    fn next(&mut self) -> Option<Self::Item> {
        let next = self.tokens.get(self.cursor).copied();
        self.cursor += 1;
        next
    }
}

impl std::fmt::Display for TokenStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut i = 0;
        while let Some(token) = self.peek(i) {
            writeln!(f, "{} in {}", token.0, token.1)?;
            i += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_stream_has_no_span_to_report() {
        let stream = TokenStream::new(vec![]);
        assert_eq!(stream.get_now_span(), Span::new(0, 0));
        assert!(stream.peek(0).is_none());
        assert!(stream.is_eof());
    }

    #[test]
    fn rollback_without_a_checkpoint_is_a_no_op() {
        let mut stream = TokenStream::new(vec![]);
        // Used to panic with "No checkpoint to rollback to!".
        stream.rollback();
        stream.commit();
    }
}
