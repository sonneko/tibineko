import type {BranchParserFunction, ProductParserFunction, HookParserFunction, IR} from "./ir.ts";

import { ParserGenerator } from "./gen_parser.ts";
import { ASTTypeGenerator } from "./gen_ast_type.ts";
import { ASTPrinterGenerator } from "./gen_ast_printer.ts";

export function getUniqueVariants(func: BranchParserFunction) {
    const list = [
        ...func.branchesJudgebleInPeek0,
        ...func.branchesJudgebleInPeek1,
        ...(func.branchesFallbackInPeek1 || []),
        ...(func.unmatchedFallback ? [func.unmatchedFallback] : []),
        ...func.branchesNeedBacktrack
    ];
    const map = new Map();
    for (const item of list) {
        map.set(item.astTypeName, { name: item.astTypeName, isBoxed: item.isBoxed });
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}


export function generate(ir: IR): [string, string, string] {
    const genParser = new ParserGenerator();
    const genAstType = new ASTTypeGenerator();
    const genPrinter = new ASTPrinterGenerator();
    return [
        genParser.generateParser(ir),
        genAstType.generateASTType(ir),
        genPrinter.generateAstPrinterImpl(ir),
    ]
}
