import { TokenMap } from "./analyze.ts";

/**
 * Contents of a Rust `b"..."` byte-string literal for `literal`, escaping
 * `"`, `\` and every byte outside printable ASCII as `\xNN` (UTF-8 bytes).
 * Previously the literal was interpolated raw, so `"` or `\` in a literal
 * produced invalid Rust.
 */
export function rustByteString(literal: string): string {
    let out = "";
    for (const byte of new TextEncoder().encode(literal)) {
        if (byte === 34) out += '\\"';
        else if (byte === 92) out += '\\\\';
        else if (byte >= 32 && byte <= 126) out += String.fromCharCode(byte);
        else out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
    return out;
}

/**
 * A single byte for a Rust `b'...'` byte literal, from a UTF-16 code unit.
 * `'` and `\` must be escaped, other non-printable / non-ASCII units become
 * `\xNN`. A unit above U+00FF is not a single byte at all, so fail loudly
 * instead of emitting `b'...'` Rust that can never compile.
 */
export function rustByteChar(charCode: number): string {
    if (charCode === 39) return "\\'";
    if (charCode === 92) return "\\\\";
    if (charCode >= 32 && charCode <= 126) return String.fromCharCode(charCode);
    if (charCode <= 255) return `\\x${charCode.toString(16).padStart(2, "0")}`;
    throw new Error(`tokenmap: character U+${charCode.toString(16).toUpperCase().padStart(4, "0")} cannot be represented as a single Rust byte literal`);
}

export function generateTokenTypeMap(tokens: TokenMap) {
    let ret = "";
    const allTokens = Object.entries(tokens.getAll()).sort((a, b) => a[0].localeCompare(b[0]));
    // How the tokenizer reaches a literal depends on its first byte:
    // word-like literals are read as identifier/keyword runs, everything
    // else falls through to the operator/delimiter scanner. A literal is
    // only scannable if it sits in the table its first byte routes to.
    const isWordStart = (literal: string) => /^[A-Za-z_]/.test(literal);
    // Languages without keywords produce an empty `phf_map!{}` and a
    // single-arm `match`, both of which trip lints in the consumer crate.
    ret += `#![allow(unused_imports)]\n`;
    ret += `#![allow(clippy::match_single_binding)]\n`;
    ret += `#![allow(clippy::zero_prefixed_literal)]\n\n`;
    ret += `use phf::phf_map;\n`;
    // TIBINEKO-FORK: module paths of the consumer crate. Edit if your runtime lives elsewhere.
    ret += `use crate::tokenizer::errors::TokenizeErrKind;\n`;
    ret += `use crate::tokenizer::tokenize::Tokenizer;\n`;
    ret += `use crate::tokenizer::tokens::{Token, Keyword, Operator, Delimiter};\n\n`;
    ret += `pub static LONG_KEYWORDS_MAP: phf::Map<&'static [u8], Token> = phf_map!{\n`;
    const tokensPhf = allTokens
        .filter(([literal, _]) => !literal.includes("#") && literal.length >= 5)
        .sort((pre, curr) => curr[0].length - pre[0].length);
    for (const [literal, token] of tokensPhf) {
        ret += `    b"${rustByteString(literal)}" => ${token.replace(/\$/g, "")},\n`;
    }
    ret += `};\n\n`;

    // Short word-like literals of any token kind, not just keywords: the
    // tokenizer reads a whole identifier-shaped run and looks it up here,
    // so a short custom token ("ab" -> Token::Foo) must be in this table
    // or it can never be produced.
    ret += `// Short word-like literals of any token kind, not just keywords:\n`;
    ret += `// the tokenizer reads a whole identifier-shaped run and looks it up\n`;
    ret += `// here, so a short custom token ("ab" -> Token::Foo) must be in this\n`;
    ret += `// table or it can never be produced.\n`;
    ret += `pub fn scan_short_keywords(literal: &[u8]) -> Token {\n`;
    ret += `    match literal {\n`;
    const tokensMatchKeywords = allTokens
        .filter(([literal, _]) => !literal.includes("#") && literal.length < 5 && isWordStart(literal))
        .sort((pre, curr) => curr[0].length - pre[0].length);
    for (const [literal, token] of tokensMatchKeywords) {
        ret += `        b"${rustByteString(literal)}" => ${token.replace(/\$/g, "")},\n`;
    }
    ret += `        _ => Token::Invalid,\n`;
    ret += `    }\n`;
    ret += `}\n\n`;

    const operators = allTokens.filter(([literal, token]) =>
        // Operators/delimiters live in the trie, and so does any literal
        // whose first byte is not word-like: the tokenizer only reaches the
        // trie for those bytes, so a punctuation-shaped custom token
        // ("@@" -> Token::Foo) must be here or it can never be produced.
        !literal.includes("#") &&
        ((token.includes("Operator") || token.includes("Delimiter")) || !isWordStart(literal))
    );
    ret += `pub fn scan_operator_or_delimiter(tokenizer: &mut Tokenizer<'_, '_>) -> Result<Token, TokenizeErrKind> {\n`;
    ret += `    let b = tokenizer.peek();\n`;
    ret += `    match b {\n`;
    const tree = buildTree(operators, 0);
    ret += generateMatchArms(tree, 1);
    ret += `        _ => Err(TokenizeErrKind::UnknownToken),\n`;
    ret += `    }\n`;
    ret += `}\n`;

    return ret;
}


type TokenData = [string, string]; // [literal, token_variant]

interface TreeNode {
    token?: string;
    children: Map<number, TreeNode>;
}

function buildTree(tokens: TokenData[], index: number): TreeNode {
    const node: TreeNode = { children: new Map() };
    for (const [literal, token] of tokens) {
        // The tokenizer matches on raw bytes, so walk the literal's UTF-8
        // bytes, not its UTF-16 code units: a multi-byte character is
        // several bytes on the wire, and a trie arm for the code unit
        // (e.g. U+00E9 as one byte 0xE9) could never match.
        const bytes = new TextEncoder().encode(literal);
        if (index === bytes.length) {
            node.token = token.replace(/\$/g, "");
            continue;
        }
        const byte = bytes[index];
        if (!node.children.has(byte)) {
            node.children.set(byte, buildTree([], index + 1));
        }
        const child = node.children.get(byte)!;
        addToTree(child, bytes, token, index + 1);
    }
    return node;
}

function addToTree(node: TreeNode, bytes: Uint8Array, token: string, index: number) {
    if (index === bytes.length) {
        node.token = token.replace(/\$/g, "");
        return;
    }
    const byte = bytes[index];
    if (!node.children.has(byte)) {
        node.children.set(byte, { children: new Map() });
    }
    addToTree(node.children.get(byte)!, bytes, token, index + 1);
}

function generateMatchArms(node: TreeNode, indent: number): string {
    let res = "";
    const space = "    ".repeat(indent);

    const sortedKeys = Array.from(node.children.keys()).sort((a, b) => a - b);

    for (const charCode of sortedKeys) {
        const char = rustByteChar(charCode);
        const child = node.children.get(charCode)!;

        res += `${space}Some(b'${char}') => {\n`;
        res += `${space}    tokenizer.advance();\n`;

        if (child.children.size > 0) {
            res += `${space}    match tokenizer.peek() {\n`;
            res += generateMatchArms(child, indent + 2);
            res += `${space}        _ => {\n`;
            if (child.token) {
                res += `${space}            Ok(${child.token})\n`;
            } else {
                res += `${space}            Err(TokenizeErrKind::UnknownToken)\n`;
            }
            res += `${space}        }\n`;
            res += `${space}    }\n`;
        } else {
            res += `${space}    Ok(${child.token})\n`;
        }
        res += `${space}}\n`;
    }
    return res;
}
