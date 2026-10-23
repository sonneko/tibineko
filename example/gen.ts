// Regenerates the committed Rust sources from grammar.tibineko + tokenmap.csv.
//
//     node gen.ts
//
// CI re-runs this and fails if the committed output changes, so the checked-in
// generated files can never drift from the grammar.
import { generate } from "../gen/index.ts";

const at = (p: string) => new URL(p, import.meta.url).pathname;

const result = generate({
    grammar: at("./grammar.tibineko"),
    tokenMap: at("./tokenmap.csv"),
    targets: {
        parser: at("./src/parser/generated_parser.rs"),
        ast: at("./src/parser/generated_ast.rs"),
        printer: at("./src/parser/generated_ast_printer.rs"),
        tokenMap: at("./src/tokenizer/generated_tokenmap.rs"),
    },
    specDir: at("./spec"),
    verbose: true,
});

console.log(`tibineko: wrote ${result.written.length} files`);
for (const path of result.written) console.log(`  ${path}`);
