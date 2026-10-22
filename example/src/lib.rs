//! A tiny config-file language, used as tibineko's end-to-end example.
//!
//! Everything under `parser/generated_*` and `tokenizer/generated_tokenmap` is
//! produced by `node gen.ts` from `grammar.tibineko` + `tokenmap.csv` and is
//! committed. The support modules are copied from the tibineko runtime and
//! from hydent-lang; see `README.md` for which is which.

pub mod compiler;
pub mod diagnostic;
pub mod parser;
pub mod tokenizer;
pub mod utility;
