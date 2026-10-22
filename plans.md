# tibineko 切り出し計画

`hydent-lang`（https://github.com/sonneko/hydent-lang）に埋め込まれているパーサージェネレータを、
tibineko として再利用可能な形に切り出すための設計・移行計画。

> **前提**：hydent-lang の Rust 部分と TypeScript 部分は意図的に密結合に設計されており、
> **Cargo クレートとして切り出すことはできない**。本計画はクレート化以外の切り出し方式を提案する。

調査対象コミット: `bb9a359`（`main`, "Merge pull request #6 from sonneko/arena/240c0c48-hydent-lang"）

---

## 1. 現状分析（実測に基づく）

### 1.1 パイプライン全体像

```
assets/grammer.tibineko  (224行, DSL名 = tibineko)
assets/tokenmap.csv      (104行, リテラル → Rust式の文字列)
        │
        ▼  parse.ts (257)   ← ast.ts (80) がGrammar型/字句規則を定義
        │      Grammar = Rule[]  （branch | product）
        │
        ▼  analyze.ts (687)
        │      nullable / FIRST(最大2トークン列) / FOLLOW /
        │      循環検出→自動boxing / LL(2)衝突検査
        │
        ▼  ir.ts (89)
        │      IR = ParserFunction[]   （kind: "branch" | "product" | "hook"）
        │
        ├─▶ gen_parser.ts (233)      → src/parser/generated_parser.rs      (643行)
        ├─▶ gen_ast_type.ts (273)    → src/parser/generated_ast.rs         (1961行)
        ├─▶ gen_ast_printer.ts (129) → src/parser/generated_ast_printer.rs (722行)
        ├─▶ gen_tokenmap.ts (113)    → src/tokenizer/generated_tokenmap.rs (298行)
        ├─▶ gen_mermaid.ts (104)     → out/spec/frontend/mermaid_grammar.html
        └─▶ check_ast_size.ts (31)   → src/parser/tests/ast_size_checker.rs
                                       ＋ `cargo test` を実行してstdoutを逆パース
```

ジェネレータ本体（`script/src/parser_gen/`）は **2,475行**（テスト447行を含む）。

### 1.2 本調査で実際に確認したこと

- ジェネレータは **Node v22.22.3 で実行可能**。`npm ci && npm run self-test` は全テスト合格。
- `npm start` を2回実行し、生成4ファイルの md5 が**完全一致**（決定論的・冪等）。
- 生成物は **git 管理外**。`.gitignore` 2–7行目が `/src/parser/generated_parser.rs`,
  `/src/parser/generated_ast.rs`, `/src/parser/generated_ast_printer.rs`,
  `/src/parser/tests/ast_size_checker.rs`, `/src/tokenizer/generated_tokenmap.rs`, `/out` を列挙。
  新鮮な clone には存在せず、CI（`setup` ジョブ）で生成 → `upload-artifact` でワークスペース全体を
  下流ジョブ（lint / unit-test / integration-test / benchmark / build-website）に配布している。
- hydent-lang は **単一クレート** `hydent_lang_compiler`（`Cargo.toml` に `[workspace]` なし）。

### 1.3 結合面の棚卸し

切り出し判断のため、各ファイルを「疎結合（切り出し可）」「密結合（対象言語に残す）」に分類した。

#### 疎結合 — 言語非依存（そのまま切り出せる）

| ファイル | 行数 | 役割 | Rust知識 |
|---|---|---|---|
| `parser_gen/ast.ts` | 80 | DSLの型定義・字句規則 | なし |
| `parser_gen/parse.ts` | 257 | DSLレキサ/パーサ | なし |
| `parser_gen/analyze.ts` | 687 | FIRST/FOLLOW/nullable/循環/衝突 | ほぼなし（後述） |
| `parser_gen/ir.ts` | 89 | 中間表現 | 型名のみ（後述） |
| `parser_gen/gen_mermaid.ts` | 104 | 文法図 | なし |
| `parser_gen/tests.ts` | 447 | ジェネレータ自身のテスト | モックで注入 |

`analyze.ts` はトークンを **不透明な文字列**として扱っており、FIRST/FOLLOW 計算は文字列等値比較のみ。
Rust 固有ロジックは含まない。テストも `mockTokenMap` を注入して言語非依存で回っている。

#### 密結合 — 対象言語（Rust）固有

| ファイル | 行数 | 結合の性質 |
|---|---|---|
| `parser_gen/gen_parser.ts` | 233 | `use crate::parser::base_parser::BaseParser;` 等を直書き（27–33行目） |
| `parser_gen/gen_ast_type.ts` | 273 | `use crate::compiler::arena::{ArenaBox, ArenaIter};` 等（57–60行目）、`pub use crate::parser::manual_ast::X`（181, 271行目） |
| `parser_gen/gen_ast_printer.ts` | 129 | `crate::` 直書き（12–14行目）＋ **`RawDeclaration` / `RawSyntaxToken` / `Identifier` / `StringLiteral` を名前でハードコード** |
| `parser_gen/gen_tokenmap.ts` | 113 | `phf_map!`・`Tokenizer::peek/advance` API を直書き |
| `parser_gen/check_ast_size.ts` | 31 | Rustテストを生成し `cargo test` を実行、stdoutをパース |

#### 密結合 — Rust ランタイム側（生成コードが依存する手書きコード）

| ファイル | 行数 | 生成コードからの参照 |
|---|---|---|
| `src/parser/base_parser.rs` | 275 | `trait BaseParser`（peek/expect/repeat/alloc_box/backtrack/…） |
| `src/parser/ast_node.rs` | 204 | `trait ASTNode` + `struct TokenSet`（u64ビットマスク） |
| `src/parser/errors.rs` | 34 | `ParseErr` / `trait IParseErr` |
| `src/parser/recovery.rs` | 50 | パニックモード回復 |
| `src/parser/tracer.rs` | 46 | `trait Tracer` / `TraceGuard` |
| `src/parser/parse.rs` | 58 | `struct Parser` が `GeneratedParser` を実装 |
| `src/tokenizer/token_stream.rs` | 75 | checkpoint / rollback / commit |
| `src/parser/manual_parser.rs` | 278 | **手書きエスケープハッチ**（`impl GeneratedParser for Parser`） |
| `src/parser/manual_ast.rs` | 72 | 手書きASTノード（`Symbol`, `Span`, `HashableFloat` を使用） |
| `src/compiler/arena.rs` | 321 | `Arena` / `ArenaBox` / `ArenaIter` |

生成コードが参照する `crate::` パスは実測で以下の9系統：

```
crate::compiler::            crate::compiler::arena::
crate::parser::ast_node::    crate::parser::base_parser::
crate::parser::errors::      crate::parser::generated_ast::
crate::parser::manual_ast::  crate::parser::tracer::
crate::tokenizer::tokens::
```

### 1.4 生成コードの結合構造（＝クレート化を阻む本体）

生成されるパーサは**独立した関数群ではなく、トレイトのデフォルトメソッド**である：

```rust
// generated_parser.rs
pub trait GeneratedParser: BaseParser + Sized {
    type TraceGuard;
    fn trace(name: &'static str) -> Self::TraceGuard;

    fn parse_BlockExpression(&mut self) -> Result<BlockExpression, Self::Error> { /* 既定実装 */ }
    // ...全ルール分
}
```

- パーサ関数は**再帰的に `self.parse_X()` を呼ぶ**ため、全ルールが単一トレイトに閉じる。
- 手書き側は `impl GeneratedParser for Parser` で **hook 関数だけ**を供給する
  （`manual_parser.rs`: `parse_RawSyntaxToken`, `parse_RawDeclaration`）。
- 生成ASTノードは `ASTNode: Copy + Clone + Debug + Hash + PartialEq + Eq + 'static + Sized` を要求し、
  `TokenSet::build_map` は `const fn` で `&[Token]` を受ける → **利用側の `Token` 型そのもの**に依存。
- `manual_ast.rs` のペイロード型は `crate::compiler::symbol::Symbol`,
  `crate::utility::hashable_float::HashableFloat`, `crate::compiler::span::Span` に依存。

### 1.5 `$...$` 規約（暗黙の契約）

`tokenmap.csv` の値は**Rustの式そのもの**であり、`$...$` でペイロード型を埋め込んでいる：

```csv
"#float",    "Token::Literal(Literal::FloatLiteral($HashableFloat<f32>$))"
"#string",   "Token::Literal(Literal::StringLiteral($Span$))"
"#identifier","Token::Identifier($Span$)"
"#fallback", "Token::Invalid"
"#raw_token","Token::Invalid"
```

ジェネレータ側は `tokenTypeName.includes("$")` で**「これは手書きノードだ」と判定**し、
`replace(/\$/g, "")` でトークン同定用の文字列を得ている。
つまり**トークン語彙の定義に Rust の型が漏れている**。これは抽出時に必ず形式化する必要がある。

### 1.6 移植性を阻むその他の実測事項

| 事項 | 内容 |
|---|---|
| ハードコードパス | `analyze.ts:42` が `'../assets/tokenmap.csv'` を直読み。`index.ts:12-24` が全出力パスを `../` 前提で固定。cwd依存。 |
| トークン数上限 | `TokenSet` は u64 ビットマスク。実測 **Keyword 46/64, Operator 36/64, Delimiter 9/64**。上限64という制約が暗黙。 |
| tokenmap.csv の重複キー | `"_"` が2回出現（後勝ちで上書き）。 |
| dead code | IR の `kind: "hook"` は3つのジェネレータ全てが処理するが、`analyze.ts` は**一度も生成しない**。実質的なhook経路は product の `$...$` 判定側。 |
| ホストツール依存 | `check_ast_size.ts` は `cargo test` を `execSync` し、`===BEGIN_REPORT===` / `===END_REPORT===` でstdoutを切り出す。CIモード限定。 |
| rustfmt依存 | CIモードで生成5ファイルを `rustfmt`。失敗は警告のみ。 |
| 公開前に直したい綴り | `Enviroment`（`base_parser.rs:66`）、`checkLL2Confilict`（`analyze.ts`）、`dublicateRemoved`（`gen_ast_type.ts:90`）、ファイル名 `grammer.tibineko`。抽出すると**公開APIとして凍結**するため先に修正すべき。 |

---

## 2. なぜ「クレート化」が成立しないのか

技術的な理由を、実測した依存関係から明示する。

1. **生成コードが `crate::` 絶対パスを出力する。**
   `crate::parser::base_parser` は「生成コードが存在するクレート内」を指す。
   別クレートに移すと `base_parser.rs` が必要とする `crate::compiler::arena` /
   `crate::diagnostic::stream` / `crate::tokenizer::tokens` / `crate::parser::errors` が解決できない。

2. **ランタイムが利用側の型に構造的に依存する。**
   `TokenSet::build_map` は `const fn` で利用側の `Token` enum を受け、
   `ASTNode` は `Copy + 'static` を要求する。汎用化するには `Token` / `Span` / `Symbol` /
   `Arena` / `DiagnosticStream` を全て型パラメータ化する必要があり、**「あえて密結合」という設計意図と衝突する**。

3. **ペイロード型が利用側の資産である。**
   `manual_ast.rs` は `Symbol`（インターン）、`HashableFloat`、`Span` を使う。
   これらはコンパイラの他パス（HIR生成等）と共有されており、切り離せない。

4. **生成物がコミットされない運用。**
   生成コードは gitignore 対象で CI が再生成する。クレートとして配布する対象がリポジトリに存在しない。

→ したがって、**「クレート境界を作る」のではなく「ソース注入＋パッケージ配布」で切り出す**のが本計画の骨子である。

---

## 3. 切り出し方式の候補

| 案 | 概要 | 評価 |
|---|---|---|
| **A. npmパッケージ ＋ Rustランタイムキット（ソース注入）** | TSコアをnpmパッケージ化。Rustランタイムは**テンプレートとして同梱し、生成時に利用側クレート内へ書き出す**。`crate::` 結合をそのまま維持。 | ✅ **推奨**。結合を壊さず、境界を作らない。 |
| B. Cargoワークスペース化 | `crates/tibineko-runtime` を作りクレート境界を作る。 | ❌ 却下。§2 の理由により型パラメータ爆発。設計意図に反する。 |
| C. git submodule / subtree で `script/parser_gen` を共有 | 発行不要で最速。 | 🔶 案Aへの**足場**として有効（Phase 2 の受け皿）。単体では版管理・API保証がない。 |
| D. `#[path]` / `include!` による共有ソース | Rustランタイムを crate 化せず共有ディレクトリから取り込む。 | 🔶 案Aの変種。`build.rs` 併用で可能だが、`crate::` 解決は結局利用側の構成に依存するため、テンプレート書き出しの方が明快。 |

---

## 4. 推奨アーキテクチャ（案A）

**「クレート境界」ではなく「4つの層＋1つの契約」で切り出す。**

```
┌─────────────────────────────────────────────────────────────┐
│ ① tibineko-core  (npm, 言語非依存)                          │
│    grammar frontend / IR / analyzer / diagnostics / mermaid │
│    → トークンは不透明な TerminalId 文字列                    │
├─────────────────────────────────────────────────────────────┤
│ ② tibineko-backend-rust  (npm, プラグイン)                  │
│    gen_parser / gen_ast_type / gen_ast_printer / tokenmap   │
│    → RustTargetConfig で import プレフィックスをパラメータ化 │
├─────────────────────────────────────────────────────────────┤
│ ③ tibineko-runtime-kit  (npmに同梱される .rs テンプレート)  │
│    base_parser / ast_node(TokenSet) / errors / recovery /   │
│    tracer / token_stream                                    │
│    → 生成時に利用側クレート内へコピー＆パス書換え            │
├─────────────────────────────────────────────────────────────┤
│ ④ 利用側クレート（hydent-lang 等）が所有し続けるもの        │
│    Token / Span / Symbol / Arena / DiagnosticStream /       │
│    manual_ast.rs / manual_parser.rs（エスケープハッチ）      │
└─────────────────────────────────────────────────────────────┘
                          ▲
                          │ 参照する単一の真実
              ┌───────────┴────────────┐
              │ 契約: tibineko.toml    │
              └────────────────────────┘
```

### 4.1 ① tibineko-core（言語非依存コア）

**含めるもの**: `ast.ts`, `parse.ts`, `analyze.ts`, `ir.ts`, `gen_mermaid.ts`, `tests.ts`, `test_utility.ts`

**変更点**:

- `ir.ts` のブランド型 `RustFunctionName` / `RustASTTypeName` / `RustTokenTypeName` を
  **言語中立名へ改名**（`FunctionName` / `NodeName` / `TerminalId`）。
  中身は現状すでにただの branded string で、実処理は Rust を知らないので改名のみで成立する。
- `TokenMap` の `readFileSync('../assets/tokenmap.csv')` 直読みを廃止し、
  **`TokenTable` インターフェースの注入**に変更する（§1.6 の cwd 依存を解消）。
- `#fallback` / `#raw_token` の特別扱い（`analyze.ts` の `computeFirst`）を
  文字列リテラル判定から**明示的な終端記述子の属性**へ移す。

**公開API（案）**:

```ts
parseGrammar(src: string): Grammar
analyze(grammar: Grammar, table: TokenTable): { ir: IR; diagnostics: Diagnostic[] }
emitMermaid(grammar: Grammar): string
```

### 4.2 ② tibineko-backend-rust（バックエンドプラグイン）

`Backend` インターフェースを実装する形で `gen_*.ts` を移す。

```ts
interface Backend<IR> {
  readonly id: string;
  emit(ir: IR, cfg: TargetConfig): GeneratedFile[];
}

interface RustTargetConfig {
  importRoot: string;        // 既定 "crate"（in-tree）／ 別構成では別値
  paths: {
    arena: string;           // "crate::compiler::arena"
    tokens: string;          // "crate::tokenizer::tokens"
    manualAst: string;       // "crate::parser::manual_ast"
    baseParser: string;      // "crate::parser::base_parser"
    // ...
  };
}
```

`gen_parser.ts:27-33` / `gen_ast_type.ts:57-60` / `gen_ast_printer.ts:12-14` の
**`crate::` 直書きを `cfg.paths.*` 参照に置換**するのが、この層の唯一かつ本質的な仕事。

**`gen_ast_printer.ts` のノード名ハードコード**（`RawDeclaration`, `RawSyntaxToken`,
`Identifier`, `StringLiteral`）は、バックエンド側の**ノード別フック登録**に置き換える：

```ts
printerHooks: { [nodeName: string]: (ctx) => string }
```

これにより「言語固有の印字ロジック」がジェネレータ本体から分離される。

### 4.3 ③ tibineko-runtime-kit（クレート化しないRust共有）— 本計画の要点

**Rustランタイムをクレートにせず、`.rs` テンプレートとして npm パッケージに同梱し、
生成時に利用側クレートのソースツリーへ書き出す。**

```
tibineko/
  runtime/rust/
    base_parser.rs.tmpl      # ← src/parser/base_parser.rs
    ast_node.rs.tmpl         # ← src/parser/ast_node.rs (TokenSet含む)
    errors.rs.tmpl
    recovery.rs.tmpl
    tracer.rs.tmpl
    token_stream.rs.tmpl
    MANIFEST.json            # バージョン・ハッシュ・要求トレイト面
```

生成時：

1. テンプレートを `<consumer>/src/parser/tibineko/` にコピー
2. import プレフィックスを `{{paths.*}}` で書換え（`crate::parser::base_parser` →
   `crate::parser::tibineko::base_parser`）
3. `mod.rs` を生成して再エクスポート
4. 生成コードに `const TIBINEKO_RUNTIME_VERSION: &str = "...";` を埋め込み、
   キットとジェネレータの版ずれをコンパイル時に検出

**この方式が成立する理由**:

- `crate::` 結合を**一切壊さない** — 共有コードは利用側クレート内に存在し続ける。
- `Token` / `Span` / `Symbol` / `Arena` は**利用側が所有し続ける**ため、汎用化が不要。
- 配布物は「ソース」なので Cargo の版解決に載らず、`hydent-lang` の
  単一クレート構成（`[workspace]` なし）を維持できる。
- 既存の `precommit.sh` / CI（生成→ビルド→テスト）のフローをそのまま踏襲できる。

**トレードオフ**: 利用側リポジトリに生成ソースが増える。
ただし現状 hydent-lang は生成物を gitignore しているため、
**ランタイムキットも同様に gitignore 対象**にすれば差分は出ない。

### 4.4 契約ファイル `tibineko.toml`

現状 `index.ts` と `tokenmap.csv` に散らばっている設定を1つに集約する。

```toml
[grammar]
path = "assets/grammer.tibineko"

[tokens]
# tokenmap.csv を「終端記述子」に置き換える（$...$ 規約の形式化）
[[terminal]]
literal = "#float"
token   = "Token::Literal(Literal::FloatLiteral({payload}))"
payload = "HashableFloat<f32>"
manual  = true          # ← 旧 "$...$" 判定の明示化

[[terminal]]
literal = "#fallback"
token   = "Token::Invalid"
role    = "fallback"    # ← 旧 "#fallback" 文字列判定の明示化

[targets.rust]
import_root = "crate"
arena       = "crate::compiler::arena"
tokens      = "crate::tokenizer::tokens"
manual_ast  = "crate::parser::manual_ast"

[outputs]
parser       = "src/parser/generated_parser.rs"
ast          = "src/parser/generated_ast.rs"
printer      = "src/parser/generated_ast_printer.rs"
tokenmap     = "src/tokenizer/generated_tokenmap.rs"
runtime_dir  = "src/parser/tibineko"

[checks]
ast_size_limit = 64
max_tokens_per_category = 64   # ← u64ビットマスク制約を明示
```

**`$...$` の形式化が重要**：現状は「文字列に `$` が含まれるか」で手書きノードを判定しており、
`gen_parser.ts` / `gen_ast_type.ts` / `gen_ast_printer.ts` の3箇所に散在している。
これを `manual: true` という明示的属性に統一する。

### 4.5 検証機構

- **`tibineko doctor`**: 利用側クレートが要求トレイト面（`BaseParser` のメソッド群、
  `ASTNode` の関連型・定数）を満たすか静的に検査。
- **conformance fixtures**: tibineko 側にゴールデン IR スナップショットを同梱し、
  コアの回帰を保証。hydent-lang 側の `compiler_test.ts`（`tests/fixture/basic/*.hyt` と
  `*-ast.json` のスナップショット比較）はそのまま利用側テストとして残す。
- **決定論チェック**: CI で生成を2回実行し md5 を比較（本調査で実施し一致を確認した手法を制度化）。

---

## 5. 移行計画

各フェーズは独立してマージ可能で、hydent-lang 側は常に緑を保つ。

### Phase 0 — 契約の凍結（本ドキュメント）
- [x] 結合面の棚卸し（§1.3）
- [x] クレート化不可の根拠明文化（§2）
- [ ] 公開APIに現れる綴り修正を hydent-lang 側に先行 PR
      （`Enviroment`→`Environment`, `checkLL2Confilict`→`checkLL2Conflict`,
      `dublicateRemoved`→`dedupedVariants`, `grammer.tibineko`→`grammar.tibineko`）

### Phase 1 — パスとトークン表の注入化（hydent-lang 内でのみ完結）
- [ ] `TokenMap` の `readFileSync('../assets/tokenmap.csv')` を DI 化
- [ ] `index.ts` の固定パス12箇所を CLI 引数／設定ファイル化
- [ ] `tokenmap.csv` の重複キー `"_"` を解消
- [ ] **検収**: 生成4ファイルの md5 が移行前と一致すること

### Phase 2 — コア／バックエンドの分離
- [ ] `parser_gen/` を `core/` と `backends/rust/` に分割（同一リポジトリ内）
- [ ] `ir.ts` のブランド型を言語中立名へ改名
- [ ] `gen_*.ts` の `crate::` 直書きを `cfg.paths.*` へ置換
- [ ] `$...$` 判定を終端記述子へ置換
- [ ] **検収**: md5 一致 ＋ `npm run self-test` 全合格

### Phase 3 — tibineko リポジトリへの移動
- [ ] `core/` を本リポジトリへ移動し npm パッケージ化
- [ ] `backends/rust/` は別パッケージ or 同一パッケージのサブパス
- [ ] hydent-lang 側は npm 依存として消費（暫定的には submodule で可）
- [ ] **検収**: hydent-lang の CI（`setup`→各ジョブ）が生成物経由で緑

### Phase 4 — Rust ランタイムキットの抽出
- [ ] `base_parser.rs` / `ast_node.rs` / `errors.rs` / `recovery.rs` / `tracer.rs` /
      `token_stream.rs` をテンプレート化
- [ ] import プレフィックス書換えと `mod.rs` 生成を実装
- [ ] `TIBINEKO_RUNTIME_VERSION` の埋め込みと版ずれ検出
- [ ] **検収**: `cargo build` / `cargo clippy -- -D warnings` / `cargo test` 緑

### Phase 5 — 検証機構の整備
- [ ] `tibineko doctor`
- [ ] conformance fixtures と決定論チェックの CI 化
- [ ] `check_ast_size.ts` の `cargo test` 往復を**任意プラグイン**として分離
      （ホストツール依存をコアから外す）

### Phase 6 — 第2の利用者で抽象を検証
- [ ] 最小のトイ言語（Rust以外でも可）を tibineko で生成してみる
- [ ] ここで漏れた結合を洗い出して契約に反映

---

## 6. リスクと未解決事項

| リスク | 内容 | 対策 |
|---|---|---|
| **u64 上限** | `TokenSet` はカテゴリごとに u64 ビットマスク。実測 Keyword 46/64 で**残り18**。 | 契約で `max_tokens_per_category = 64` を宣言し、ジェネレータが超過を検出してエラー化。 |
| **ランタイムのドリフト** | テンプレート書き出し方式では、利用側がキットを直接編集できてしまう。 | 生成ヘッダ＋`TIBINEKO_RUNTIME_VERSION`＋doctor で検出。 |
| **`hook` の dead code** | IR の `kind: "hook"` は3ジェネレータが処理するが `analyze.ts` が生成しない。 | Phase 2 で「明示的な hook 宣言構文」を実装するか削除するかを決める。**現状は文法から hook を指定できない**。 |
| **プリンタのハードコード** | `gen_ast_printer.ts` がノード名4つを直書き。 | §4.2 のフック登録へ。 |
| **生成物の非コミット運用** | 生成物が gitignore のため、tibineko 側のスナップショットテストが「期待出力」を持てない。 | コアの検証は **IR / 中間JSON レベルのスナップショット**で行い、Rust出力の検証は利用側 CI に委ねる（現状の分業を維持）。 |
| **rustfmt / cargo 依存** | CIモードでホストツールに依存。 | 任意プラグイン化（Phase 5）。 |

### 未解決（要検討）

- npm 発行するか、当面 submodule 運用で留めるか（Phase 3 の分岐点）。
- `Token` enum の `#[repr(u8)]` 順序と `tokenmap.csv` の対応を**機械的に検証**する仕組み
  （現状は人間が同期を保っている。ずれても `1 << (keyword as u8)` が黙って壊れる）。
- `manual_parser.rs`（278行）のエスケープハッチ契約をどこまで tibineko 側の保証に含めるか。

---

## 付録: 調査手順の再現

```bash
git clone https://github.com/sonneko/hydent-lang.git
cd hydent-lang/script
npm ci
npm run self-test      # ジェネレータ自身のテスト（全合格を確認）
npm start              # 生成（決定論性は md5 を2回採取して一致を確認）
```

本ドキュメントに記載した行数・トークン数・`crate::` パス・md5 一致は、
コミット `bb9a359` を対象に上記手順で実測した値である。
