import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import { parse } from "./parse.ts";
import { analyze, TokenMap } from "./analyze.ts";
import { generate as generateRust } from "./gen.ts";
import { astName } from "./ir.ts";
import { generateTokenTypeMap } from "./gen_tokenmap.ts";
import { generateMermaidHtml } from "./gen_mermaid.ts";

/**
 * Everything tibineko needs to know about your project. There is deliberately
 * no config-file schema and no CLI flag parser: you own a ~10 line entry
 * script that fills this in. See `seed/gen.ts`.
 */
export interface TibinekoConfig {
    /** Path to the `.tibineko` grammar. */
    grammar: string;
    /** Path to the token map CSV (`"literal", "TokenExpr"` per line). */
    tokenMap: string;
    /**
     * Generated Rust outputs. Leave a key out to skip that artifact.
     * Paths are used verbatim, so you decide where things land in your crate.
     */
    targets: {
        parser?: string;
        ast?: string;
        printer?: string;
        /** Scanner tables for the tokenizer. */
        tokenMap?: string;
        /** The `#[ignore]`d test that reports AST struct sizes. */
        astSizeChecker?: string;
    };
    /** Where to drop `ast.json`, `ir.json` and the mermaid diagram. */
    specDir?: string;
    /** Warn when an AST struct exceeds this many bytes (cache-line-ish). */
    astSizeLimit?: number;
    /** Extra log lines; the analyzer reports grammar smells here. */
    verbose?: boolean;
}

export interface GenerateResult {
    /** Grammar warnings (FIRST/FOLLOW overlap and friends). */
    analysisOutput: string;
    /** Files written, in the order they were written. */
    written: string[];
    /** Rule name -> byte size, when the size checker ran. */
    astSizes?: { ast: string; size: number }[];
}

function write(path: string, contents: string, written: string[]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
    written.push(path);
}

/**
 * Runs the whole pipeline: grammar -> AST -> IR -> Rust sources.
 *
 * This function does no I/O beyond reading the two inputs and writing the
 * declared targets. It never shells out; the `cargo test` round trip lives in
 * `./check_ast_size.ts` and is opt-in.
 */
export function generate(cfg: TibinekoConfig): GenerateResult {
    const written: string[] = [];

    const tokens = TokenMap.fromFile(cfg.tokenMap);
    const grammar = parse(readFileSync(cfg.grammar, "utf8"));
    const [ir, analysisOutput] = analyze(grammar, tokens.getAll());

    if (cfg.verbose && analysisOutput.trim().length > 0) {
        console.log(analysisOutput);
    }

    if (cfg.specDir) {
        const spec = cfg.specDir.replace(/\/$/, "");
        write(`${spec}/ast.json`, JSON.stringify(grammar, null, 2), written);
        write(`${spec}/ir.json`, JSON.stringify(ir, stableReplacer, 2), written);
        write(`${spec}/mermaid_grammar.html`, generateMermaidHtml(grammar), written);
    }

    if (cfg.targets.tokenMap) {
        write(cfg.targets.tokenMap, generateTokenTypeMap(tokens), written);
    }

    const [parser, ast, printer] = generateRust(ir);
    if (cfg.targets.parser) write(cfg.targets.parser, parser, written);
    if (cfg.targets.ast) write(cfg.targets.ast, ast, written);
    if (cfg.targets.printer) write(cfg.targets.printer, printer, written);

    return { analysisOutput, written };
}

/** Rule names every AST struct the grammar produces, for the size checker. */
export function astTypeNames(grammarPath: string): string[] {
    return parse(readFileSync(grammarPath, "utf8")).map(rule => astName(rule.name));
}

/** Keeps generated JSON diffs stable regardless of Set/Map insertion order. */
function stableReplacer(_key: string, value: unknown): unknown {
    if (value instanceof Map) {
        return Object.fromEntries(
            [...value.entries()].sort(([a], [b]) => String(a).localeCompare(String(b))),
        );
    }
    if (value instanceof Set) {
        return [...value].sort();
    }
    return value;
}
