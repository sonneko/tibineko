// Run with:  node gen.ts
import { generate } from "../gen/index.ts";

const result = generate({
    grammar: new URL("./grammar.tibineko", import.meta.url).pathname,
    tokenMap: new URL("./tokenmap.csv", import.meta.url).pathname,
    targets: {
        parser: new URL("./generated/generated_parser.rs", import.meta.url).pathname,
        ast: new URL("./generated/generated_ast.rs", import.meta.url).pathname,
        printer: new URL("./generated/generated_ast_printer.rs", import.meta.url).pathname,
        tokenMap: new URL("./generated/generated_tokenmap.rs", import.meta.url).pathname,
    },
    specDir: new URL("./generated/spec", import.meta.url).pathname,
    verbose: true,
});

console.log(`tibineko: wrote ${result.written.length} files`);
for (const path of result.written) console.log(`  ${path}`);
