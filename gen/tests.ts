import { describe, it, match } from './test_utility.ts';
import { analyze, Analyzer, TokenMap } from './analyze.ts';
import type {Grammar} from './ast.ts';
import { ASTTypeGenerator } from './gen_ast_type.ts';
import { expectedTokenValue, ParserGenerator } from './gen_parser.ts';
import { parse } from "./parse.ts";
import { parseASTSizeCheckerResult } from "./check_ast_size.ts";
import { generateTokenTypeMap } from "./gen_tokenmap.ts";
import { generateMermaidHtml } from "./gen_mermaid.ts";

describe('Parser (parse.ts)', () => {
    it('should parse Branch and Product rules correctly', () => {
        const src = `
            branch Expr {
                AddExpr
                SubExpr with "boxed"
            }
            product AddExpr {
                left: Expr
                "+"
                right: Expr
            }
            product SubExpr with "TerminalSub"
        `;
        const ast = parse(src);
        match(ast.length).toBe(3);
        match(ast[0].kind).toBe('Branch');
        match((ast[0] as any).variants[1].note).toBe('boxed');

        match(ast[1].kind).toBe('Product');
        match((ast[1] as any).members.length).toBe(3);

        match(ast[2].kind).toBe('Product');
        match((ast[2] as any).members[0].value).toBe('TerminalSub');
    });

    it('should parse repeated and optional elements correctly', () => {
        const src = `
            product ListRule {
                items: *Expr
                opt: ?Expr
            }
        `;
        const ast = parse(src);
        match(ast.length).toBe(1);
        const members = (ast[0] as any).members;
        match(members[0].type.modifier).toBe('List');
        match(members[1].type.modifier).toBe('Option');
    });

    it('should not let a block comment swallow the following rule', () => {
        const ast = parse(`/* c1 */ product A with "a" /* c2 */ product B with "b"`);
        match(ast.length).toBe(2);
        match((ast[0] as any).name).toBe('A');
        match((ast[1] as any).name).toBe('B');
    });

    it('should accept a multi-line block comment', () => {
        const ast = parse(`/* line one\nline two */ product A with "a"`);
        match(ast.length).toBe(1);
        match((ast[0] as any).name).toBe('A');
    });

    it('should accept a line comment at end of file without a trailing newline', () => {
        const ast = parse(`product A with "a" // trailing`);
        match(ast.length).toBe(1);
        match((ast[0] as any).name).toBe('A');
    });
});

describe('parseASTSizeCheckerResult (check_ast_size.ts)', () => {
    it('should return every entry in the report, not just the first', () => {
        const result = parseASTSizeCheckerResult("===BEGIN_REPORT===\nFoo:8\nBar:16\nBaz:24\n===END_REPORT===\n");
        match(result.length).toBe(3);
        match(result).toContainEqual({ ast: 'Foo', size: 8 });
        match(result).toContainEqual({ ast: 'Bar', size: 16 });
        match(result).toContainEqual({ ast: 'Baz', size: 24 });
    });

    it('should return an empty list when there is no report', () => {
        match(parseASTSizeCheckerResult("no report here").length).toBe(0);
    });
});

describe('generateTokenTypeMap (gen_tokenmap.ts)', () => {
    it('should strip every $ placeholder, not just the first two', () => {
        const out = generateTokenTypeMap(new TokenMap({ "hello": "Token::Foo($A$, $B$)" }));
        match(out).toContain('Token::Foo(A, B)');
    });

    it('should escape quote and backslash operator literals in byte literals', () => {
        const out = generateTokenTypeMap(new TokenMap({
            "'": "Token::Operator(Operator::Quote)",
            "\\": "Token::Operator(Operator::Backslash)",
        }));
        match(out).toContain("Some(b'\\'')");
        match(out).toContain("Some(b'\\\\')");
    });

    it('should escape non-ASCII literals as UTF-8 byte escapes', () => {
        const out = generateTokenTypeMap(new TokenMap({ "ééééé": "Token::Keyword(Keyword::Foo)" }));
        match(out).toContain('b"\\xc3\\xa9');
    });

    it('should route short non-Keyword literals to a scanner table', () => {
        const out = generateTokenTypeMap(new TokenMap({
            "ab": "Token::Foo",
            "@@": "Token::Bar",
        }));
        // Word-like short literals are looked up as identifier-shaped runs.
        match(out).toContain('b"ab" => Token::Foo,');
        // Punctuation-shaped literals are only reachable through the trie.
        match(out).toContain("Some(b'@')");
        match(out).toContain('Ok(Token::Bar)');
    });

    it('should walk non-ASCII operator literals byte by byte in the trie', () => {
        const out = generateTokenTypeMap(new TokenMap({
            "é": "Token::Operator(Operator::EAcute)",
        }));
        // "é" is two UTF-8 bytes (0xC3 0xA9); a trie arm for the single
        // UTF-16 code unit could never match the byte stream.
        match(out).toContain("Some(b'\\xc3')");
        match(out).toContain("Some(b'\\xa9')");
    });
});

describe('TokenMap', () => {
    it('should fail loudly on a malformed CSV row, naming the line', () => {
        match(() => TokenMap.fromCsv('"a", "TokenA"\nthis is not csv\n"b", "TokenB"\n')).toThrowError('tokenmap: line 2');
    });

    it('should skip blank lines in a tokenmap CSV', () => {
        const map = TokenMap.fromCsv('\n"a", "TokenA"\n\n"b", "TokenB"\n');
        match(Object.keys(map.getAll()).length).toBe(2);
    });

    it('should reject more than 64 variants in one token category', () => {
        const record: Record<string, string> = {};
        for (let i = 0; i < 65; i++) {
            record[`kw${i}xx`] = `Token::Keyword(Keyword::K${i})`;
        }
        match(() => new TokenMap(record)).toThrowError('64-token limit');
        const ok: Record<string, string> = {};
        for (let i = 0; i < 64; i++) {
            ok[`kw${i}xx`] = `Token::Keyword(Keyword::K${i})`;
        }
        match(new TokenMap(ok)).toBeDefined();
    });
});

describe('generateMermaidHtml (gen_mermaid.ts)', () => {
    it('should define branch classes under the same name it inherits from', () => {
        const html = generateMermaidHtml([
            { kind: 'Branch', name: 'Value', variants: [{ name: 'NumberLiteral', note: '' }] },
            { kind: 'Product', name: 'NumberLiteral', members: [{ kind: 'Terminal', value: '#int', note: '' }] },
        ]);
        match(html).toContain('class Value');
        match(html).toContain('Value <|-- NumberLiteral');
        match(html.includes('class _Value')).toBe(false);
    });
});

describe('Analyzer', () => {
    const mockTokenMap = {
        'a': 'TokenA',
        'b': 'TokenB',
        'c': 'TokenC',
        '#doc_comment': 'Token::Comment(Comment::DocComment($Span$))',
        '#fallback': 'Token::Invalid',
        '#raw_token': 'Token::Invalid',
    };

    describe('computeNullable', () => {
        it('should correctly identify nullable rules', () => {
            const grammar: Grammar = [
                // Empty -> (empty)
                { kind: 'Product', name: 'EmptyRule', members: [] },
                // HasTerminal -> "a"
                { kind: 'Product', name: 'HasTerminal', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                // OptionRule -> Identifier?
                {
                    kind: 'Product', name: 'OptionRule', members: [
                        { kind: 'Field', name: 'id', type: { name: 'SomeId', modifier: 'Option' }, note: '' }
                    ]
                },
                // BranchRule -> EmptyRule | HasTerminal
                {
                    kind: 'Branch', name: 'BranchNullable', variants: [
                        { name: 'EmptyRule', note: '' },
                        { name: 'HasTerminal', note: '' }
                    ]
                }
            ];

            const analyzer = new Analyzer(grammar, mockTokenMap);
            analyzer.computeNullable();

            match(analyzer.nullable.has('EmptyRule')).toBe(true);
            match(analyzer.nullable.has('HasTerminal')).toBe(false);
            match(analyzer.nullable.has('OptionRule')).toBe(true);
            match(analyzer.nullable.has('BranchNullable')).toBe(true);
        });
    });

    describe('computeFirst & computeFollow', () => {
        it('should compute FIRST and FOLLOW sets correctly for simple sequences', () => {
            const grammar: Grammar = [
                // S -> A "b"
                {
                    kind: 'Product', name: 'S', members: [
                        { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                        { kind: 'Terminal', value: 'b', note: '' }
                    ]
                },
                // A -> "a"
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'a', note: '' }] }
            ];

            const analyzer = new Analyzer(grammar, mockTokenMap);
            analyzer.analyze();

            const firstS = (analyzer as any).firstSets.get('S');
            match([...firstS][0]).toBe('TokenA,TokenB');

            const followA = (analyzer as any).followSets.get('A');
            match([...followA][0]).toBe('TokenB');
        });

        it('should handle List modifiers by adding FIRST to FOLLOW', () => {
            const grammar: Grammar = [
                // ListRule -> A*
                {
                    kind: 'Product', name: 'ListRule', members: [
                        { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'List' }, note: '' }
                    ]
                },
                // A -> "a"
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'a', note: '' }] }
            ];

            const analyzer = new Analyzer(grammar, mockTokenMap);
            analyzer.analyze();

            const followA = (analyzer as any).followSets.get('A');
            match([...followA][0]).toBe('TokenA');
        });
    });

    describe('computeFirst & computeFollow complex cases', () => {
        it('should account for multiple repetitions when computing two-token FIRST sequences', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'Modifier', variants: [
                    { name: 'A', note: '' },
                    { name: 'B', note: '' },
                ]},
                { kind: 'Product', name: 'A', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Product', name: 'B', members: [
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'modifiers', type: { name: 'Modifier', modifier: 'List' }, note: '' },
                    { kind: 'Terminal', value: 'c', note: '' },
                ]},
            ];
            const analyzer = new Analyzer(grammar, mockTokenMap);
            analyzer.analyze();
            const firstS = (analyzer as any).firstSets.get('S') as Set<string>;

            match([...firstS]).toContain('TokenA,TokenB');
            match([...firstS]).toContain('TokenB,TokenA');
            match([...firstS]).toContain('TokenA,TokenC');
        });

        it('should correctly compute FIRST and FOLLOW sets with mutually recursive and nullable rules', () => {
            const grammar: Grammar = [
                // S -> A B C
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Field', name: 'b', type: { name: 'B', modifier: 'None' }, note: '' },
                    { kind: 'Field', name: 'c', type: { name: 'C', modifier: 'None' }, note: '' }
                ]},
                // A -> "a" | A_empty
                { kind: 'Branch', name: 'A', variants: [{ name: 'A_a', note: '' }, { name: 'A_empty', note: '' }] },
                { kind: 'Product', name: 'A_a', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                { kind: 'Product', name: 'A_empty', members: [] },
                // B -> "b" | B_empty
                { kind: 'Branch', name: 'B', variants: [{ name: 'B_b', note: '' }, { name: 'B_empty', note: '' }] },
                { kind: 'Product', name: 'B_b', members: [{ kind: 'Terminal', value: 'b', note: '' }] },
                { kind: 'Product', name: 'B_empty', members: [] },
                // C -> "c"
                { kind: 'Product', name: 'C', members: [{ kind: 'Terminal', value: 'c', note: '' }] },
            ];

            const analyzer = new Analyzer(grammar, mockTokenMap);
            analyzer.analyze();

            const firstS = (analyzer as any).firstSets.get('S');
            const firstSArray = [...firstS];
            match(firstSArray).toContain('TokenA,TokenB'); // A->a, B->b
            match(firstSArray).toContain('TokenA,TokenC'); // A->a, B->empty
            match(firstSArray).toContain('TokenB,TokenC'); // A->empty, B->b
            match(firstSArray).toContain('TokenC');        // A->empty, B->empty

            const followA = (analyzer as any).followSets.get('A');
            const followAArray = [...followA];
            match(followAArray).toContain('TokenB'); // when B is not empty
            match(followAArray).toContain('TokenC'); // when B is empty
        });
    });

    describe('analyzeBranchRule', () => {
        it('should differentiate branches into Peek0 and Peek1', () => {
            const grammar: Grammar = [
                // Branch -> V1 | V2 | V3
                {
                    kind: 'Branch', name: 'Branch', variants: [
                        { name: 'V1', note: '' },
                        { name: 'V2', note: '' },
                        { name: 'V3', note: '' }
                    ]
                },
                // V1 -> "a" "b"
                { kind: 'Product', name: 'V1', members: [{ kind: 'Terminal', value: 'a', note: '' }, { kind: 'Terminal', value: 'b', note: '' }] },
                // V2 -> "a" "c"
                { kind: 'Product', name: 'V2', members: [{ kind: 'Terminal', value: 'a', note: '' }, { kind: 'Terminal', value: 'c', note: '' }] },
                // V3 -> "b"
                { kind: 'Product', name: 'V3', members: [{ kind: 'Terminal', value: 'b', note: '' }] },
            ];

            const [ir] = analyze(grammar, mockTokenMap);
            const branchIR = ir.find(i => i.kind === 'branch') as any;

            match(branchIR).toBeDefined();

            match(branchIR.branchesJudgebleInPeek0).toContainEqual(
                { astTypeName: 'V3', firstTerminal: 'TokenB' }
            );

            match(branchIR.branchesJudgebleInPeek1).toContainEqual(
                { astTypeName: 'V1', firstTerminal: 'TokenA', secondTerminal: 'TokenB' }
            );
            match(branchIR.branchesJudgebleInPeek1).toContainEqual(
                { astTypeName: 'V2', firstTerminal: 'TokenA', secondTerminal: 'TokenC' }
            );
        });
    });

    describe('ParserGenerator', () => {
        it('tries ambiguous alternatives before falling back to a one-token branch', () => {
            const grammar: Grammar = [
                {
                    kind: 'Branch', name: 'Choice', variants: [
                        { name: 'LongB', note: '' },
                        { name: 'LongC', note: '' },
                        { name: 'Short', note: '' },
                    ]
                },
                { kind: 'Product', name: 'LongB', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
                { kind: 'Product', name: 'LongC', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                    { kind: 'Terminal', value: 'c', note: '' },
                ]},
                { kind: 'Product', name: 'Short', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const generated = new ParserGenerator().generateParser(ir);
            const backtrack = generated.indexOf('this.parse_LongB()');
            const fallback = generated.indexOf('Ok(Choice::Short(self.parse_Short()?))');

            match(backtrack >= 0).toBe(true);
            match(fallback > backtrack).toBe(true);
        });

        it('uses a diagnostic-free wildcard fallback after cleanly trying known alternatives', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'Choice', variants: [
                    { name: 'Known', note: '' },
                    { name: 'RawDeclaration', note: '' },
                ]},
                { kind: 'Product', name: 'Known', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Product', name: 'RawDeclaration', members: [
                    { kind: 'Terminal', value: '#fallback', note: '' },
                ]},
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const choice = ir.find(item => item.astTypeName === 'Choice');
            const generatedParser = new ParserGenerator().generateParser(ir);
            const generatedAst = new ASTTypeGenerator().generateASTType(ir);

            match(choice !== undefined && choice.kind === 'branch'
                ? choice.unmatchedFallback?.astTypeName
                : undefined).toBe('RawDeclaration');
            match(generatedParser).toContain('self.backtrack_clean(|this| this.parse_Known())');
            match(generatedParser).toContain(
                'Err(_) => Ok(Choice::RawDeclaration(self.parse_RawDeclaration()?))'
            );
            match(generatedParser.includes('Some(Token::Invalid)')).toBe(false);
            match(generatedAst).toContain('Token::Invalid');
            match(generatedAst.includes('FOLLOW_SETS: TokenSet = TokenSet::build_map(false, false, false, true, &[Token::Invalid])')).toBe(false);
        });

        it('generates TokenSet FIRST/FOLLOW maps and includes follow lookahead for one-token items', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'Item', variants: [
                    { name: 'Short', note: '' },
                    { name: 'Long', note: '' },
                ]},
                { kind: 'Product', name: 'Short', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Product', name: 'Long', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
                { kind: 'Product', name: 'Parent', members: [
                    { kind: 'Field', name: 'items', type: { name: 'Item', modifier: 'List' }, note: '' },
                    { kind: 'Terminal', value: 'c', note: '' },
                ]},
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const generated = new ASTTypeGenerator().generateASTType(ir);

            match(generated.includes('TokenBitMap')).toBe(false);
            match(generated.includes(
                'const FIRST_2_SETS: TokenSet = TokenSet::build_map(false, false, false, true, &[TokenA, TokenB, TokenC]);'
            )).toBe(true);
        });

        it('represents comment terminals in generated TokenSets', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'DocCommentNode', members: [
                    { kind: 'Terminal', value: '#doc_comment', note: '' },
                ]},
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const generated = new ASTTypeGenerator().generateASTType(ir);

            match(generated.includes(
                'const FIRST_1_SETS: TokenSet = TokenSet::build_map(false, false, true, false, &[]);'
            )).toBe(true);
        });
    });

    describe('computeCycle (Boxed Types)', () => {
        it('should mark recursive fields as boxed to prevent infinite size in Rust', () => {
            const grammar: Grammar = [
                // Expr -> "a" | AddExpr
                {
                    kind: 'Branch', name: 'Expr', variants: [
                        { name: 'Term', note: '' },
                        { name: 'AddExpr', note: '' }
                    ]
                },
                // Term -> "a"
                { kind: 'Product', name: 'Term', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                // AddExpr -> Expr "b"
                {
                    kind: 'Product', name: 'AddExpr', members: [
                        { kind: 'Field', name: 'left', type: { name: 'Expr', modifier: 'None' }, note: '' },
                        { kind: 'Terminal', value: 'b', note: '' }
                    ]
                }
            ];

            const [ir] = analyze(grammar, mockTokenMap);

            const addExprIR = ir.find(i => i.astTypeName === 'AddExpr' && i.kind === 'product') as any;
            match(addExprIR).toBeDefined();

            const exprElement = addExprIR.elements.find((e: any) => e.astTypeName === 'Expr');

            const exprIR = ir.find(i => i.astTypeName === 'Expr' && i.kind === 'branch') as any;
            match(exprIR).toBeDefined();

            const addExprRef = [...exprIR.branchesJudgebleInPeek1][0];

            // Exactly one edge of the cycle is boxed: the DFS back-edge
            // (Expr -> AddExpr, the branch alternative). The tree edge
            // (AddExpr -> Expr, the product field) stays inline — boxing
            // both would compile but add an indirection for nothing. The
            // old test accepted either one via `or()`, which hid a failure
            // in the other; assert both sides precisely instead.
            match(exprElement.kind).toBe('normal');
            match(addExprRef.isBoxed).toBe(true);
        });
    });

    describe('checkLL2Confilict', () => {
        it('should detect FIRST/FOLLOW overlap using the first token of a two-token FIRST sequence', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Product', name: 'A', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
            ];
            const [ir, warnings] = analyze(grammar, mockTokenMap);

            // The overlap is reported as a warning, and the generated code
            // takes the two-token path: FIRST_2_SETS carries the second
            // token, which is what lets `repeat` decide whether to continue.
            // (There used to be a `firstAndFollowConflict` flag on the IR
            // for this; nothing ever read it, so it was removed.)
            match(warnings).toContain('TokenA');
            const generated = new ASTTypeGenerator().generateASTType(ir);
            match(generated).toContain(
                'const FIRST_2_SETS: TokenSet = TokenSet::build_map(false, false, false, false, &[TokenB]);'
            );
        });

        it('should throw for a nullable rule whose two-token FIRST starts in FOLLOW', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Branch', name: 'A', variants: [
                    { name: 'A_long', note: '' },
                    { name: 'A_empty', note: '' },
                ]},
                { kind: 'Product', name: 'A_long', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
                { kind: 'Product', name: 'A_empty', members: [] },
            ];

            match(() => analyze(grammar, mockTokenMap)).toThrowError('Grammar conflict');
        });

        it('should throw an error if a Nullable rule has intersecting FIRST and FOLLOW sets', () => {
            // S -> A "a"
            // A -> "a" | (empty)
            const grammar: Grammar = [
                {
                    kind: 'Product', name: 'S', members: [
                        { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                        { kind: 'Terminal', value: 'a', note: '' }
                    ]
                },
                {
                    kind: 'Branch', name: 'A', variants: [
                        { name: 'A_a', note: '' },
                        { name: 'A_empty', note: '' }
                    ]
                },
                { kind: 'Product', name: 'A_a', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                { kind: 'Product', name: 'A_empty', members: [] },
            ];

            const analyzer = new Analyzer(grammar, mockTokenMap);

            match(() => {
                analyzer.analyze();
            }).toThrowError('Grammar conflict');
        });
    });

    describe('Grammar validation', () => {
        it('should reject duplicate rule names', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'b', note: '' }] },
            ];
            match(() => analyze(grammar, mockTokenMap)).toThrowError('duplicate rule "A"');
        });

        it('should reject references to undefined rules', () => {
            const branchGrammar: Grammar = [
                { kind: 'Branch', name: 'S', variants: [{ name: 'Missing', note: '' }] },
            ];
            match(() => analyze(branchGrammar, mockTokenMap)).toThrowError('undefined rule "Missing"');
            const fieldGrammar: Grammar = [
                { kind: 'Product', name: 'P', members: [{ kind: 'Field', name: 'x', type: { name: 'NoSuch', modifier: 'None' }, note: '' }] },
            ];
            match(() => analyze(fieldGrammar, mockTokenMap)).toThrowError('undefined rule "NoSuch"');
        });

        it('should reject duplicate field names in a product', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'P', members: [
                    { kind: 'Field', name: 'x', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Field', name: 'x', type: { name: 'A', modifier: 'None' }, note: '' },
                ]},
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
            ];
            match(() => analyze(grammar, mockTokenMap)).toThrowError('declares field "x" twice');
        });

        it('should reject a branch with no variants, and a branch that can never match', () => {
            const emptyBranch: Grammar = [
                { kind: 'Branch', name: 'S', variants: [] },
            ];
            match(() => analyze(emptyBranch, mockTokenMap)).toThrowError('has no variants');
            const deadBranch: Grammar = [
                { kind: 'Branch', name: 'S', variants: [{ name: 'E', note: '' }] },
                { kind: 'Product', name: 'E', members: [] },
            ];
            match(() => analyze(deadBranch, mockTokenMap)).toThrowError('can never match');
        });

        it('should warn about a single dead variant instead of failing the whole grammar', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                ]},
                { kind: 'Branch', name: 'A', variants: [
                    { name: 'A_a', note: '' },
                    { name: 'A_empty', note: '' },
                ]},
                { kind: 'Product', name: 'A_a', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
                { kind: 'Product', name: 'A_empty', members: [] },
            ];
            const [, warnings] = analyze(grammar, mockTokenMap);
            match(warnings).toContain('variant "A_empty" can never match');
        });
    });

    describe('#fallback in FOLLOW', () => {
        it('should not let #fallback pollute FOLLOW sets with Token::Invalid', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'x', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Terminal', value: '#fallback', note: '' },
                ]},
                { kind: 'Product', name: 'A', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const a = ir.find(item => item.astTypeName === 'A') as any;
            match(a).toBeDefined();
            match(a.syncPointsTerminals.includes('Token::Invalid')).toBe(false);
            const generated = new ASTTypeGenerator().generateASTType(ir);
            match(generated.includes('FOLLOW_SETS: TokenSet = TokenSet::build_map(false, false, false, true, &[Token::Invalid])')).toBe(false);
        });
    });

    describe('Branch variants', () => {
        it('should honour with "boxed" on a branch variant', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'E', variants: [{ name: 'S', note: 'boxed' }] },
                { kind: 'Product', name: 'S', members: [{ kind: 'Terminal', value: 'a', note: '' }] },
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const e = ir.find(item => item.astTypeName === 'E') as any;
            match(e).toBeDefined();
            match(e.branchesJudgebleInPeek0[0].isBoxed).toBe(true);
            const generated = new ASTTypeGenerator().generateASTType(ir);
            match(generated).toContain('S(ArenaBox<S>)');
        });

        it('should reject two #fallback variants in one branch instead of dropping one', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'S', variants: [
                    { name: 'F1', note: '' },
                    { name: 'F2', note: '' },
                ]},
                { kind: 'Product', name: 'F1', members: [{ kind: 'Terminal', value: '#fallback', note: '' }] },
                { kind: 'Product', name: 'F2', members: [{ kind: 'Terminal', value: '#fallback', note: '' }] },
            ];
            match(() => analyze(grammar, mockTokenMap)).toThrowError('2 #fallback variants');
        });
    });

    describe('IR firstTerminals', () => {
        it('should store FIRST sequences as arrays, not comma-joined strings', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'A', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const a = ir.find(item => item.astTypeName === 'A') as any;
            match(JSON.stringify(a.firstTerminals)).toBe(JSON.stringify([["TokenA", "TokenB"]]));
        });
    });

    describe('Product FIRST/FOLLOW sets', () => {
        it('should dedupe and sort product FIRST/FOLLOW sets like the branch side', () => {
            const grammar: Grammar = [
                { kind: 'Product', name: 'S', members: [
                    { kind: 'Field', name: 'a', type: { name: 'A', modifier: 'None' }, note: '' },
                    { kind: 'Field', name: 'b', type: { name: 'B', modifier: 'None' }, note: '' },
                ]},
                { kind: 'Branch', name: 'A', variants: [
                    { name: 'A1', note: '' },
                    { name: 'A2', note: '' },
                ]},
                { kind: 'Product', name: 'A1', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'b', note: '' },
                ]},
                { kind: 'Product', name: 'A2', members: [
                    { kind: 'Terminal', value: 'a', note: '' },
                    { kind: 'Terminal', value: 'c', note: '' },
                ]},
                { kind: 'Product', name: 'B', members: [{ kind: 'Terminal', value: 'b', note: '' }] },
            ];
            const [ir] = analyze(grammar, mockTokenMap);
            const generated = new ASTTypeGenerator().generateASTType(ir);
            // S's FIRST is TokenA once per sequence without the fix.
            const sBlock = generated.split('impl ASTNode for S {')[1].split('impl ASTNode for ')[0];
            match(sBlock.includes('TokenA, TokenA')).toBe(false);
            match(sBlock).toContain('FIRST_1_SETS: TokenSet = TokenSet::build_map(false, false, false, false, &[TokenA]);');
        });
    });

    describe('Branch error expected lists', () => {
        const payloadTokenMap = {
            ...mockTokenMap,
            '#int': 'Token::Literal(Literal::IntegerLiteral($i32$))',
            '#string': 'Token::Literal(Literal::StringLiteral($Span$))',
            '#bool': 'Token::Literal(Literal::BoolLiteral($bool$))',
            '#identifier': 'Token::Identifier($Span$)',
            '[': 'Token::Delimiter(Delimiter::LeftBracket)',
            '(': 'Token::Delimiter(Delimiter::LeftParen)',
        };

        it('should include $-payload tokens in error expected lists', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'Value', variants: [
                    { name: 'NumberLiteral', note: '' },
                    { name: 'StringLiteral', note: '' },
                    { name: 'BoolLiteral', note: '' },
                    { name: 'ListValue', note: '' },
                    { name: 'GroupedValue', note: '' },
                ]},
                { kind: 'Product', name: 'NumberLiteral', members: [{ kind: 'Terminal', value: '#int', note: '' }] },
                { kind: 'Product', name: 'StringLiteral', members: [{ kind: 'Terminal', value: '#string', note: '' }] },
                { kind: 'Product', name: 'BoolLiteral', members: [{ kind: 'Terminal', value: '#bool', note: '' }] },
                { kind: 'Product', name: 'ListValue', members: [{ kind: 'Terminal', value: '[', note: '' }] },
                { kind: 'Product', name: 'GroupedValue', members: [{ kind: 'Terminal', value: '(', note: '' }] },
            ];
            const [ir] = analyze(grammar, payloadTokenMap);
            const generated = new ParserGenerator().generateParser(ir);
            match(generated).toContain('Token::Literal(Literal::IntegerLiteral(0))');
            match(generated).toContain('Token::Literal(Literal::StringLiteral(Span::new(0, 0)))');
            match(generated).toContain('Token::Literal(Literal::BoolLiteral(false))');
            match(generated).toContain('Token::Delimiter(Delimiter::LeftBracket)');
            match(generated).toContain('Token::Delimiter(Delimiter::LeftParen)');
            // The list is &'static [Token] and contains a Span::new(0, 0),
            // which does not const-promote in an inline array, so it lives
            // in a function-local const item the error references.
            match(generated).toContain('const EXPECTED_VALUE: &[Token] = &[');
            match(generated).toContain('                EXPECTED_VALUE,');
            // No identifier is expected here, so the flag must be false.
            match(generated).toContain('Self::Error::build(\n                false,');
        });

        it('should flag an expected identifier, and list the other tokens', () => {
            const grammar: Grammar = [
                { kind: 'Branch', name: 'Entry', variants: [
                    { name: 'Pair', note: '' },
                    { name: 'Note', note: '' },
                ]},
                { kind: 'Product', name: 'Pair', members: [
                    { kind: 'Field', name: 'key', type: { name: 'Identifier', modifier: 'None' }, note: '' },
                    { kind: 'Terminal', value: 'a', note: '' },
                ]},
                { kind: 'Product', name: 'Identifier', members: [{ kind: 'Terminal', value: '#identifier', note: '' }] },
                { kind: 'Product', name: 'Note', members: [{ kind: 'Terminal', value: '#doc_comment', note: '' }] },
            ];
            const [ir] = analyze(grammar, payloadTokenMap);
            const generated = new ParserGenerator().generateParser(ir);
            // The identifier itself cannot be listed: its payload is a
            // Symbol, which has no public const constructor. Its
            // presence is conveyed by the `true` flag instead, and the
            // other expected token (the doc comment) is listed.
            match(generated).toContain('Token::Comment(Comment::DocComment(Span::new(0, 0)))');
            match(generated.includes('Token::Identifier(Span::new(0, 0))')).toBe(false);
            match(generated).toContain('Self::Error::build(\n                true,');
        });

        it('should not fabricate values it cannot construct const-ly', () => {
            // Identifier: Symbol payload, no const constructor.
            match(expectedTokenValue('Token::Identifier($Span$)')).toBe(null);
            // Float literals: the token payload is a wrapper type
            // (HashableFloat<f32>), not a plain f32.
            match(expectedTokenValue('Token::Literal(Literal::FloatLiteral($f32$)')).toBe(null);
            // Unknown payload types stay out of the list.
            match(expectedTokenValue('Token::Literal(Literal::Custom($MyType$)')).toBe(null);
            // The fabricable ones still work.
            match(expectedTokenValue('Token::Literal(Literal::IntegerLiteral($i32$))')).toBe('Token::Literal(Literal::IntegerLiteral(0))');
            match(expectedTokenValue('Token::Literal(Literal::CharLiteral($char$))')).toBe("Token::Literal(Literal::CharLiteral('\\0'))");
        });
    });
});
