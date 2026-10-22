// Copy this next to your grammar and edit the paths. This is the only
// tibineko-related file you are expected to own and maintain.
//
//     node gen.ts
//
// No npm install: Node >= 22.6 strips the types for you.
import { generate } from "./tibineko/gen/index.ts";

const result = generate({
    grammar: "assets/grammar.tibineko",
    tokenMap: "assets/tokenmap.csv",
    targets: {
        parser: "src/parser/generated_parser.rs",
        ast: "src/parser/generated_ast.rs",
        printer: "src/parser/generated_ast_printer.rs",
        tokenMap: "src/tokenizer/generated_tokenmap.rs",
    },
    specDir: "out/spec/frontend",
    verbose: true,
});

console.log(`tibineko: wrote ${result.written.length} files`);
for (const path of result.written) console.log(`  ${path}`);
