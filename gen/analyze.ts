import { readFileSync } from "fs";

import type {BranchRule, Grammar, ProductRule, Rule} from "./ast.ts";
import type {BranchParserFunction, IR, ParserFunction, ProductParserFunction, RustASTTypeName, RustTokenTypeName} from "./ir.ts";
import {astName, fnName, tokenName} from "./ir.ts";

type TokenSeq = RustTokenTypeName[];

function seqKey(seq: TokenSeq): string {
    return seq.join(",");
}

function parseSeqKey(key: string): TokenSeq {
    if (key === "") return [];
    return key.split(",").map(tokenName);
}

function concatSeq(a: TokenSeq, b: TokenSeq): TokenSeq {
    const combined = [...a, ...b];
    return combined.slice(0, 2);
}

/**
 * The terminal vocabulary: maps a grammar literal (`"fn"`, `"#int"`,
 * `"#fallback"`, ...) to the token expression the backend emits.
 *
 * TIBINEKO-FORK: values are Rust expressions. A `$...$` span marks the token's
 * payload type and flags the node as hand-written (see `manual_ast`). Backends
 * that do not target Rust must reinterpret this format.
 */
export class TokenMap {
    private map: Record<string, string>;

    public constructor(record: Record<string, string>) {
        this.map = record;
        this.checkTokenCategorySizes();
    }

    /**
     * `TokenSet` stores each token category as a `u64` bitmask indexed by the
     * enum discriminant (`1 << (keyword as u8)`), so a category with more
     * than 64 distinct variants cannot be represented: discriminant 64
     * panics in debug builds and silently collides with another variant's
     * bit in release builds. The generator cannot see the consumer enum's
     * declaration order, but the token map is the full vocabulary the
     * generator emits, so more than 64 distinct variants in one category
     * guarantees at least one discriminant is out of range.
     */
    private checkTokenCategorySizes() {
        const counts = new Map<string, Set<string>>();
        for (const expr of Object.values(this.map)) {
            const m = /Token::(Keyword|Operator|Delimiter)\((\w+)::(\w+)\)/.exec(expr);
            if (!m) continue;
            const [, category, , variant] = m;
            let set = counts.get(category);
            if (!set) {
                set = new Set();
                counts.set(category, set);
            }
            set.add(variant);
        }
        for (const [category, variants] of [...counts.entries()].sort()) {
            if (variants.size > 64) {
                throw new Error(
                    `tokenmap: ${variants.size} distinct ${category} variants exceed the 64-token limit of TokenSet's u64 bitmask; ` +
                    `split the category or widen TokenSet to u128 in your copy`
                );
            }
        }
    }

    /**
     * Parses the `"literal", "TokenExpr"` CSV form.
     * Duplicate literals are rejected: last-one-wins silently produced a real
     * bug upstream, where `"_"` appeared twice.
     */
    public static fromCsv(csv: string): TokenMap {
        const map = new Map<string, string>();
        const duplicates: string[] = [];
        for (const [index, line] of csv.split('\n').entries()) {
            if (line.trim() === '') continue;
            const parts = line.split('"');
            if (parts.length >= 4 && parts[1] && parts[3]) {
                if (map.has(parts[1])) duplicates.push(parts[1]);
                map.set(parts[1], parts[3]);
            } else {
                // A malformed row used to be skipped silently, and the
                // failure only surfaced later as an unrelated
                // "no token definition" error for a literal that looked
                // present. Fail here, naming the line.
                throw new Error(`tokenmap: line ${index + 1} is not a "literal", "TokenExpr" pair: ${JSON.stringify(line)}`);
            }
        }
        if (duplicates.length > 0) {
            const listed = [...new Set(duplicates)].map(d => JSON.stringify(d)).join(", ");
            throw new Error(`tokenmap: duplicate literal(s) ${listed}; later entries would silently win`);
        }
        return new TokenMap(Object.fromEntries(map));
    }

    public static fromFile(path: string): TokenMap {
        return TokenMap.fromCsv(readFileSync(path, 'utf8'));
    }

    public get(key: string): RustTokenTypeName {
        const val = this.map[key];
        if (!val) {
            throw new Error(`tokenmap: no token definition for literal ${JSON.stringify(key)}`);
        }
        return tokenName(val);
    }

    public getAll(): Record<string, string> {
        return this.map;
    }
}

export class Analyzer {
    private grammar: Grammar;
    private tokenMap: TokenMap;
    private ruleMap: Map<string, Rule>;
    private outputs: string[];

    public nullable: Set<string> = new Set();
    private firstSets: Map<string, Set<string>> = new Map();
    private followSets: Map<string, Set<string>> = new Map();

    public constructor(grammar: Grammar, tokenMap: Record<string, string>) {
        this.grammar = [...grammar].sort((a, b) => a.name.localeCompare(b.name));
        this.tokenMap = new TokenMap(tokenMap);
        this.ruleMap = new Map();
        this.outputs = [];

        for (const rule of grammar) {
            this.ruleMap.set(rule.name, rule);
        }
    }

    public analyze(): [IR, string] {
        this.validateGrammar();
        this.computeNullable();
        this.computeFirst();
        this.computeFollow();
        this.checkDeadBranches();

        const funcs: ParserFunction[] = [];
        for (const rule of this.grammar) {
            switch (rule.kind) {
                case "Branch":
                    funcs.push(this.analyzeBranchRule(rule));
                    break;
                case "Product":
                    funcs.push(this.analyzeProductRule(rule));
                    break;
            }
        }
        this.computeCycle(funcs);
        this.checkLL2Confilict();

        return [funcs, this.outputs.join("\n\n")];
    }

    /**
     * Structural checks that used to slip through and surface much later as
     * broken Rust (a call to a `parse_NoSuch()` that does not exist, a
     * `parse_A` emitted twice, a struct field declared twice). Failing here
     * names the grammar rule instead of a generated line.
     */
    private validateGrammar() {
        const seen = new Set<string>();
        for (const rule of this.grammar) {
            if (seen.has(rule.name)) {
                throw new Error(`grammar: duplicate rule "${rule.name}"; rename one of them`);
            }
            seen.add(rule.name);
        }

        for (const rule of this.grammar) {
            if (rule.kind === "Branch") {
                if (rule.variants.length === 0) {
                    throw new Error(`grammar: branch "${rule.name}" has no variants`);
                }
                for (const v of rule.variants) {
                    if (!this.ruleMap.has(v.name)) {
                        throw new Error(`grammar: branch "${rule.name}" refers to undefined rule "${v.name}"`);
                    }
                }
            } else {
                const fields = new Set<string>();
                for (const m of rule.members) {
                    if (m.kind === "Terminal") {
                        // Throws with a clear message when the literal has
                        // no token-map entry.
                        this.tokenMap.get(m.value);
                    } else {
                        if (!this.ruleMap.has(m.type.name)) {
                            throw new Error(`grammar: product "${rule.name}" field "${m.name}" refers to undefined rule "${m.type.name}"`);
                        }
                        if (fields.has(m.name)) {
                            throw new Error(`grammar: product "${rule.name}" declares field "${m.name}" twice`);
                        }
                        fields.add(m.name);
                    }
                }
            }
        }
    }

    /**
     * A branch whose FIRST set is empty can never match: the generated
     * parser dispatches on the next token, and no token leads anywhere, so
     * every use of the branch fails. The one exception is a `#fallback`
     * variant, which is reached without a token (see `unmatchedFallback`).
     * A single dead variant in an otherwise live branch is only a warning:
     * nullable empty variants are a legitimate (if usually mistaken) way to
     * spell an optional alternative, and the LL(2) check below still
     * rejects the cases that are actually ambiguous.
     */
    private checkDeadBranches() {
        for (const rule of this.grammar) {
            if (rule.kind !== "Branch") continue;
            const first = this.firstSets.get(rule.name);
            if (first && first.size === 0 && !rule.variants.some(v => this.isFallbackRule(v.name))) {
                throw new Error(`grammar: branch "${rule.name}" can never match (its FIRST set is empty); every variant is empty or refers to an empty rule`);
            }
            for (const v of rule.variants) {
                const variantFirst = this.firstSets.get(v.name);
                if (variantFirst && variantFirst.size === 0 && !this.isFallbackRule(v.name)) {
                    this.outputs.push(`    👀 WARNING: branch "${rule.name}" variant "${v.name}" can never match (its FIRST set is empty)`);
                }
            }
        }
    }

    public checkLL2Confilict() {
        const allRules = this.grammar.map(v => v.name);
        allRules.forEach(name => {
            const firstSets = this.firstSets.get(name)!;
            const followSets = this.followSets.get(name)!;
            const firstTerminals = new Set(
                [...firstSets]
                    .map(sequence => parseSeqKey(sequence)[0])
                    .filter((token): token is RustTokenTypeName => token !== undefined)
            );
            const intersection = new Set([...firstTerminals].filter(token => followSets.has(token)));
            if (intersection.size !== 0) {
                this.outputs.push(`    👀 WARNING: Tokens in both First and Follow sets: ${[...intersection].join(", ")} in Rule ${name}`);
                if (this.nullable.has(name)) {
                    this.outputs.push(`❌ LL(2) Conflict in Nullable Rule "${name}":`);
                    this.outputs.push(`  Tokens in both First and Follow sets: ${[...intersection].sort().join(", ")}`);
                    throw new Error("Grammar conflict");
                }
            }
        });
    }

    public computeNullable() {
        let changed = true;
        while (changed) {
            changed = false;
            for (const rule of this.grammar) {
                const wasNullable = this.nullable.has(rule.name);
                let isNullable = false;

                if (rule.kind === "Branch") {
                    for (const v of rule.variants) {
                        if (this.nullable.has(v.name)) {
                            isNullable = true;
                            break;
                        }
                    }
                } else if (rule.kind === "Product") {
                    let allNullable = true;
                    if (rule.members.length === 0) {
                        allNullable = true;
                    } else {
                        for (const m of rule.members) {
                            if (m.kind === "Terminal") {
                                allNullable = false;
                                break;
                            } else {
                                if (m.type.modifier === "Option" || m.type.modifier === "List") {
                                    continue;
                                }
                                if (!this.nullable.has(m.type.name)) {
                                    allNullable = false;
                                    break;
                                }
                            }
                        }
                    }
                    isNullable = allNullable;
                }

                if (isNullable && !wasNullable) {
                    this.nullable.add(rule.name);
                    changed = true;
                }
            }
        }
    }

    private computeFirst() {
        for (const rule of this.grammar) {
            this.firstSets.set(rule.name, new Set());
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const rule of this.grammar) {
                const currentSet = this.firstSets.get(rule.name)!;
                const oldSize = currentSet.size;

                if (rule.kind === "Branch") {
                    for (const v of rule.variants) {
                        const variantFirst = this.firstSets.get(v.name);
                        if (variantFirst) {
                            for (const seqStr of variantFirst) {
                                currentSet.add(seqStr);
                            }
                        }
                    }
                } else if (rule.kind === "Product") {
                    let seqs: TokenSeq[] = [[]];

                    for (const m of rule.members) {
                        let memberFirsts: TokenSeq[] = [];

                        if (m.kind === "Terminal") {
                            // These pseudo terminals declare a manual parser hook,
                            // not a token that participates in FIRST/FOLLOW sets.
                            // TIBINEKO-FORK: pseudo-terminals that declare a manual parser hook.
                            if (m.value === "#fallback" || m.value === "#raw_token") {
                                memberFirsts = [];
                            } else {
                                const t = this.tokenMap.get(m.value);
                                memberFirsts = [[t]];
                            }
                        } else {
                            const refName = m.type.name;
                            const refModifier = m.type.modifier;

                            const subFirstStrs = this.firstSets.get(refName);
                            const subFirsts = subFirstStrs
                                ? [...subFirstStrs].map(parseSeqKey)
                                : [];

                            if (refModifier === "List") {
                                memberFirsts = this.repeatFirstSequences(subFirsts);
                            } else {
                                memberFirsts = subFirsts;
                                if (refModifier === "Option" || this.nullable.has(refName)) {
                                    memberFirsts.push([]);
                                }
                            }
                        }

                        const nextSeqs: TokenSeq[] = [];
                        for (const base of seqs) {
                            for (const suffix of memberFirsts) {
                                if (base.length >= 2) {
                                    nextSeqs.push(base);
                                } else {
                                    nextSeqs.push(concatSeq(base, suffix));
                                }
                            }
                        }
                        seqs = nextSeqs;
                        if (seqs.every(s => s.length >= 2)) break;
                    }

                    for (const s of seqs) {
                        if (s.length > 0) {
                            currentSet.add(seqKey(s));
                        }
                    }
                }

                if (currentSet.size !== oldSize) {
                    changed = true;
                }
            }
        }
    }

    private repeatFirstSequences(firsts: TokenSeq[]): TokenSeq[] {
        const sequences = new Map<string, TokenSeq>([[seqKey([]), []]]);
        const queue: TokenSeq[] = [[]];

        while (queue.length > 0) {
            const base = queue.shift()!;
            if (base.length >= 2) continue;

            for (const suffix of firsts) {
                if (suffix.length === 0) continue;
                const sequence = concatSeq(base, suffix);
                const key = seqKey(sequence);
                if (sequences.has(key)) continue;

                sequences.set(key, sequence);
                if (sequence.length < 2) queue.push(sequence);
            }
        }

        return [...sequences.values()];
    }

    private computeFollow() {
        for (const rule of this.grammar) {
            this.followSets.set(rule.name, new Set());
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const rule of this.grammar) {
                if (rule.kind === "Branch") {
                    const ruleFollow = this.followSets.get(rule.name);
                    if (ruleFollow) {
                        for (const v of rule.variants) {
                            const variantFollow = this.followSets.get(v.name);
                            if (variantFollow) {
                                const oldSize = variantFollow.size;
                                for (const f of ruleFollow) {
                                    variantFollow.add(f);
                                }
                                if (variantFollow.size !== oldSize) {
                                    changed = true;
                                }
                            }
                        }
                    }
                } else if (rule.kind === "Product") {
                    const members = rule.members;
                    for (let i = 0; i < members.length; i++) {
                        const current = members[i];
                        if (current.kind === "Terminal") continue;

                        const targetName = current.type.name;
                        const targetFollow = this.followSets.get(targetName);
                        if (!targetFollow) continue;

                        const oldSize = targetFollow.size;
                        let allSubsequentNullable = true;
                        let lookaheadSeqs: TokenSeq[] = [[]];

                        for (let j = i + 1; j < members.length; j++) {
                            const next = members[j];
                            let nextFirsts: TokenSeq[] = [];

                            if (next.kind === "Terminal") {
                                // Pseudo-terminals declare a manual parser
                                // hook, not a token: like computeFirst, they
                                // contribute nothing here. Treating them as
                                // a real token used to put Token::Invalid
                                // into FOLLOW sets, which matches every
                                // non-EOF token and broke repeat/recovery
                                // sync points.
                                if (next.value === "#fallback" || next.value === "#raw_token") {
                                    nextFirsts = [[]];
                                } else {
                                    nextFirsts = [[this.tokenMap.get(next.value)]];
                                    allSubsequentNullable = false;
                                }
                            } else {
                                const nName = next.type.name;
                                const nMod = next.type.modifier;

                                const fs = this.firstSets.get(nName);
                                if (fs) fs.forEach(s => nextFirsts.push(parseSeqKey(s)));

                                if (nMod !== "List" && nMod !== "Option" && !this.nullable.has(nName)) {
                                    allSubsequentNullable = false;
                                } else {
                                    nextFirsts.push([]);
                                }
                            }

                            const nextLookaheads: TokenSeq[] = [];
                            for (const base of lookaheadSeqs) {
                                for (const suffix of nextFirsts) {
                                    nextLookaheads.push(concatSeq(base, suffix));
                                }
                            }
                            lookaheadSeqs = nextLookaheads;
                            if (!allSubsequentNullable) break;
                        }

                        // リスト（*Item）の場合、自身が連続する可能性があるため、自身の FIRST 集合を FOLLOW 集合に含める必要がある
                        if (current.type.modifier === "List") {
                            const currentFirsts = this.firstSets.get(targetName);
                            if (currentFirsts) {
                                for (const f of currentFirsts) {
                                    const seq = parseSeqKey(f);
                                    if (seq.length > 0) {
                                        targetFollow.add(seq[0]);
                                    }
                                }
                            }
                        }

                        for (const seq of lookaheadSeqs) {
                            if (seq.length > 0) {
                                targetFollow.add(seq[0]);
                            }
                        }

                        if (allSubsequentNullable) {
                            const ruleFollow = this.followSets.get(rule.name);
                            if (ruleFollow) {
                                for (const f of ruleFollow) {
                                    targetFollow.add(f);
                                }
                            }
                        }

                        if (targetFollow.size !== oldSize) {
                            changed = true;
                        }
                    }
                }
            }
        }
    }

    private computeCycle(funcs: ParserFunction[]): ParserFunction[] {
        const graph = new Map<RustASTTypeName, RustASTTypeName[]>();
        this.grammar.forEach(rule => {
            switch (rule.kind) {
                case "Branch":
                    rule.variants.forEach(v => {
                        const target = graph.get(astName(rule.name));
                        if (target === undefined) {
                            graph.set(astName(rule.name), [astName(v.name)]);
                        } else {
                            target.push(astName(v.name))
                        }
                    });
                    break;
                case "Product":
                    rule.members.forEach(v => {
                        if (v.kind === "Field" && v.type.modifier !== "List") {
                            const target = graph.get(astName(rule.name));
                            if (target === undefined) {
                                graph.set(astName(rule.name), [astName(v.type.name)]);
                            } else {
                                target.push(astName(v.type.name))
                            }
                        }
                    });
                    break;
            }
        });

        const visiting = new Set<RustASTTypeName>();
        const visited = new Set<RustASTTypeName>();
        const shouldBeBoxed = new Set<string>();

        const visit = (node: RustASTTypeName) => {
            if (visited.has(node)) {
                return;
            }
            visiting.add(node);
            for (const to of graph.get(node) ?? []) {
                if (visiting.has(to)) {
                    shouldBeBoxed.add(`${node}:${to}`);
                } else {
                    visit(to);
                }
            }
            visiting.delete(node);
            visited.add(node);
        }

        const startNodes = [...graph.keys()].sort();

        for (const node of startNodes) {
            if (visited.has(node)) continue;
            visit(node);
        }

        [...shouldBeBoxed].sort().forEach(v => {
            const separated = v.split(":");
            const from = astName(separated[0]);
            const to = astName(separated[1]);
            for (const f of funcs) {
                if (f.astTypeName !== from) continue;
                switch (f.kind) {
                    case "branch":
                        [...f.branchesFallbackInPeek1, ...f.branchesJudgebleInPeek0, ...f.branchesJudgebleInPeek1, ...f.branchesNeedBacktrack].forEach(b => {
                            if (b.astTypeName === to) {
                                b.isBoxed = true;
                            }
                        });
                        break;
                    case "product":
                        f.elements.forEach(e => {
                            if (e.kind === "terminal") return;
                            if (e.astTypeName === to) {
                                switch (e.kind) {
                                    case "boxed":
                                    case "normal":
                                        e.kind = "boxed";
                                        break;
                                    case "repeat":
                                        break;
                                    case "option":
                                    case "optionWithBox":
                                        e.kind = "optionWithBox";
                                        break;
                                }
                            }
                        });
                        break;
                    case "hook":
                        break;
                }
            }
        });

        return funcs;
    }

    private isFallbackRule(name: string): boolean {
        const rule = this.ruleMap.get(name);
        return rule?.kind === "Product"
            && rule.members.length === 1
            && rule.members[0].kind === "Terminal"
            // TIBINEKO-FORK: literal name of the catch-all rule.
            && rule.members[0].value === "#fallback";
    }

    private analyzeBranchRule(rule: BranchRule): BranchParserFunction {
        const mapPeek0: Record<string, string[]> = {};
        const mapPeek1: Record<string, Record<string, string[]>> = {};
        const mapPeek1Fallback: Record<string, string[]> = {};

        // `with "boxed"` on a variant forces boxing, exactly like on a
        // product field (docs/grammar.md). The note is a substring match,
        // so `with "boxed: recursive"` works too.
        const boxedVariants = new Set(
            rule.variants.filter(v => v.note.includes("boxed")).map(v => v.name),
        );
        const isBoxed = (name: string) => boxedVariants.has(name);

        // Only one catch-all variant is supported: the generated parser
        // falls back to a single `unmatchedFallback`, so a second one
        // used to be dropped silently from the enum.
        const fallbackVariants = rule.variants.filter(variant => this.isFallbackRule(variant.name));
        if (fallbackVariants.length > 1) {
            const names = fallbackVariants.map(v => `"${v.name}"`).join(", ");
            throw new Error(`grammar: branch "${rule.name}" has ${fallbackVariants.length} #fallback variants (${names}); only one catch-all variant is supported`);
        }

        for (const v of rule.variants) {
            const vSet = this.firstSets.get(v.name);
            const seqs: TokenSeq[] = [];
            if (vSet) {
                vSet.forEach(s => seqs.push(parseSeqKey(s)));
            }

            for (const seq of seqs) {
                if (seq.length === 0) continue;

                const t0 = seq[0];
                if (!mapPeek0[t0]) mapPeek0[t0] = [];
                if (!mapPeek0[t0].includes(v.name)) mapPeek0[t0].push(v.name);

                if (seq.length > 1) {
                    const t1 = seq[1];
                    if (!mapPeek1[t0]) mapPeek1[t0] = {};
                    if (!mapPeek1[t0][t1]) mapPeek1[t0][t1] = [];
                    if (!mapPeek1[t0][t1].includes(v.name)) mapPeek1[t0][t1].push(v.name);
                } else {
                    if (!mapPeek1Fallback[t0]) mapPeek1Fallback[t0] = [];
                    if (!mapPeek1Fallback[t0].includes(v.name)) mapPeek1Fallback[t0].push(v.name);
                }
            }
        }

        const branchesJudgebleInPeek0: BranchParserFunction["branchesJudgebleInPeek0"] = [];
        const branchesJudgebleInPeek1: BranchParserFunction["branchesJudgebleInPeek1"] = [];
        const branchesFallbackInPeek1: BranchParserFunction["branchesFallbackInPeek1"] = [];
        const branchesNeedBacktrack: BranchParserFunction["branchesNeedBacktrack"] = [];
        const expectedTerminals: RustTokenTypeName[] = [];
        const unmatchedFallback = rule.variants.find(variant => this.isFallbackRule(variant.name));

        Object.keys(mapPeek0).sort().forEach(t0 => {
            expectedTerminals.push(tokenName(t0));
            const variants = mapPeek0[t0];

            if (variants.length === 1) {
                branchesJudgebleInPeek0.push({
                    astTypeName: astName(variants[0]),
                    firstTerminal: tokenName(t0),
                    isBoxed: isBoxed(variants[0]),
                });
            } else {
                const secondMap = mapPeek1[t0] || {};
                const fallbacks = mapPeek1Fallback[t0] || [];

                if (fallbacks.length > 1) {
                    fallbacks.forEach(v => {
                        branchesNeedBacktrack.push({
                            astTypeName: astName(v),
                            firstTerminal: tokenName(t0),
                            secondTerminal: tokenName("_"),
                            isBoxed: isBoxed(v),
                        });
                    });
                }

                for (const t1 in secondMap) {
                    const varsInT1 = secondMap[t1];
                    if (varsInT1.length === 1) {
                        branchesJudgebleInPeek1.push({
                            astTypeName: astName(varsInT1[0]),
                            firstTerminal: tokenName(t0),
                            secondTerminal: tokenName(t1),
                            isBoxed: isBoxed(varsInT1[0]),
                        });
                    } else {
                        varsInT1.forEach(v => {
                            branchesNeedBacktrack.push({
                                astTypeName: astName(v),
                                firstTerminal: tokenName(t0),
                                secondTerminal: tokenName(t1),
                                isBoxed: isBoxed(v),
                            });
                        });
                    }
                }

                if (fallbacks.length === 1) {
                    branchesFallbackInPeek1.push({
                        astTypeName: astName(fallbacks[0]),
                        firstTerminal: tokenName(t0),
                        isBoxed: isBoxed(fallbacks[0]),
                    });
                }
            }
        });

        const syncPointsTerminals: RustTokenTypeName[] = [];
        const follow = this.followSets.get(rule.name);
        if (follow) {
            [...follow].sort().forEach(t => syncPointsTerminals.push(tokenName(t)));
        }

        // FIRST is a set of token *sequences* (up to two tokens for LL(2)),
        // kept as real arrays: the old comma-joined strings ("TokenA,TokenB")
        // leaked into ir.json, where consumers had to split them back apart.
        let firstTerminals: RustTokenTypeName[][] = [];
        const firstSets = this.firstSets.get(rule.name);
        if (firstSets) {
            firstTerminals = [...firstSets].map(parseSeqKey);
        }

        return {
            kind: "branch",
            functionName: fnName(rule.name),
            astTypeName: astName(rule.name),
            expectedTerminals,
            syncPointsTerminals,
            firstTerminals,
            branchesJudgebleInPeek0,
            branchesJudgebleInPeek1,
            branchesFallbackInPeek1,
            unmatchedFallback: unmatchedFallback
                ? { astTypeName: astName(unmatchedFallback.name), isBoxed: isBoxed(unmatchedFallback.name) }
                : null,
            branchesNeedBacktrack
        };
    }

    private analyzeProductRule(rule: ProductRule): ProductParserFunction {
        const elements: ProductParserFunction["elements"] = [];
        for (const member of rule.members) {
            switch (member.kind) {
                case "Field":
                    switch (member.type.modifier) {
                        case "None":
                            if (member.note.includes("boxed")) {
                                elements.push({ kind: "boxed", astTypeName: astName(member.type.name), name: member.name });
                            } else {
                                elements.push({ kind: "normal", astTypeName: astName(member.type.name), name: member.name  });
                            }
                            break;
                        case "Option":
                            if (member.note.includes("boxed")) {
                                elements.push({ kind: "optionWithBox", astTypeName: astName(member.type.name), name: member.name  });
                            } else {
                                elements.push({ kind: "option", astTypeName: astName(member.type.name), name: member.name  });
                            }
                            break;
                        case "List":
                            elements.push({ kind: "repeat", astTypeName: astName(member.type.name), name: member.name  });
                            break;
                    }
                    break;
                case "Terminal":
                    elements.push({
                        kind: "terminal",
                        tokenTypeName: this.tokenMap.get(member.value),
                    });
                    break;
            }
        }

        const syncPointsTerminals: RustTokenTypeName[] = [];
        const follow = this.followSets.get(rule.name);
        if (follow) {
            follow.forEach(t => syncPointsTerminals.push(tokenName(t)));
        }

        // See analyzeBranchRule: FIRST sequences are real arrays, not
        // comma-joined strings.
        let firstTerminals: RustTokenTypeName[][] = [];
        const firstSets = this.firstSets.get(rule.name);
        if (firstSets) {
            firstTerminals = [...firstSets].map(parseSeqKey);
        }

        return {
            kind: "product",
            functionName: fnName(rule.name),
            astTypeName: astName(rule.name),
            syncPointsTerminals,
            firstTerminals,
            elements,
        };
    }
}

export function analyze(grammar: Grammar, tokenMap: Record<string, string>): [IR, string] {
    const analyzer = new Analyzer(grammar, tokenMap);
    return analyzer.analyze();
}
