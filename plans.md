# tibineko 切り出し計画（v2・シンプル版）

`hydent-lang` のパーサージェネレータを tibineko として切り出す。

**方針を v1 から大幅に単純化した。** パッケージ発行も、プラグイン機構も、設定スキーマも作らない。
Zig と同じやり方をする — **コードベースをまるごとレポジトリに突っ込んで使う**。

調査対象: `hydent-lang@bb9a359`

---

## 1. Zig 思想との対応

| Zig の原則 | 現状のジェネレータ | 判定 |
|---|---|---|
| 隠れた制御フローなし | 生成物はテーブル駆動ではなく**素の再帰降下パーサ**。人が読んで追える | ✅ 既に達成 |
| 隠れたメモリ確保なし | `Arena` / `ArenaBox` / `ArenaIter` が明示的 | ✅ 既に達成 |
| ビルドに魔法がない | ❌ **Node を先に動かさないと `cargo build` が通らない** | ⚠️ 要修正 |
| 依存はソースごと持つ | ❌ npm パッケージ化を検討していた | ⚠️ 本計画で修正 |

**「ビルドに魔法がある」の実測根拠**: `src/parser/mod.rs:25-27` が
`mod generated_ast; / mod generated_ast_printer; / mod generated_parser;` を宣言し、
`src/tokenizer/mod.rs:5` が `pub mod generated_tokenmap;` を宣言しているが、
**この4ファイルはすべて git 未追跡**（`.gitignore` 2–7行目）。
新鮮な clone には存在しないため、Rust 単体ではビルドできない。

---

## 2. なぜ「まるごと突っ込む」で成立するのか

v1 で問題視していた密結合は、**vendoring すれば問題ではなくなる**。

生成コードが `crate::` 絶対パスを直書きしていること（実測19箇所）は、
「別クレートに切り出せない」理由にはなるが、
**「利用側レポジトリのソースツリーに置く」なら何も問題がない** —
`crate::` はそのまま正しく解決する。

つまり v1 の最大の仕事だった「ランタイムキットをテンプレート化して
import プレフィックスを書き換える」機構は、**まるごと不要になる**。

---

## 3. 必要な変更は3つだけ

### 変更1: npm 依存をゼロにする ✅ 実測で達成済み

Node v22.22.3 は type stripping がデフォルト有効（`node --help` に
`--no-experimental-strip-types` が出る＝有効側のフラグ）。よって **`.ts` は素の `node` で直接動く**。
動かない理由は2つだけで、どちらも機械的に直せる：

| 障害 | 件数 | 対処 |
|---|---|---|
| 相対 import に拡張子がない | **27箇所** | `.ts` を付ける |
| 型のみ import が `import type` でない | **10文**（34名前） | `import type {…}` に分割 |
| 副作用 import に拡張子がない | **1箇所**（`self_test.ts:1`） | `.ts` を付ける |

**実測結果**（`node_modules` を削除した状態で実施）:

```
$ node ./src/index.ts        # tsx なし・npm ci なしで生成成功
✅ TokenMap / AST / IR / Parser / Mermaid すべて出力

$ node ./src/self_test.ts
passed: 16   failed: 0   exit: 0
```

さらに **生成4ファイルの md5 が `tsx` 実行時と完全一致**：

```
416406c581f4f2e76b0aae56b61d24d3  generated_ast.rs
72b668719ef438457bcd143c5304e640  generated_parser.rs
2c5f54fab0a5020401d1f46e23f94ecf  generated_ast_printer.rs
0718f789dc687448bf718bb597662e0c  generated_tokenmap.rs
```

→ **`package.json` / `package-lock.json` / `node_modules` / `tsx` は全部捨てられる。**
tibineko を使うのに npm install は不要。

### 変更2: 生成物をコミットする

現状は gitignore。これを**コミットする**方針に変える。

- `cargo build` が Node なしで通る（§1 の「ビルドの魔法」が消える）
- 生成パーサを読んでデバッグできる（Zig の「ソースを読めば分かる」）
- CI が「生成ジョブ → artifact 配布 → 下流ジョブ」という多段構成をやめられる

### 変更3: パスを「設定可能」にせず「規約」で固定する

現状 `analyze.ts:42` が `'../assets/tokenmap.csv'` を直読みし、`index.ts:12-24` が12個のパスを固定している。

v1 はこれを設定ファイル化しようとしていたが、**逆に規約として固定する**。
利用者が所有する10行程度のエントリスクリプトが定数を渡すだけ。
TOML スキーマも CLI 引数パーサも作らない。

---

## 4. ディレクトリ構成

### tibineko レポジトリ（このレポジトリ）

```
tibineko/
  README.md          ← 使い方は「この2ディレクトリをコピーしろ」だけ
  VERSION
  gen/               ← TSジェネレータ。まるごとコピー、編集しない
    index.ts
    parse.ts  analyze.ts  ir.ts  ast.ts
    gen_parser.ts  gen_ast_type.ts  gen_ast_printer.ts
    gen_tokenmap.ts  gen_mermaid.ts  check_ast_size.ts
    tests.ts  test_utility.ts  self_test.ts
  runtime/           ← Rustランタイム。まるごとコピー、編集しない
    base_parser.rs   ast_node.rs(TokenSet)   errors.rs
    recovery.rs      tracer.rs               token_stream.rs
  seed/              ← 初回だけコピー。以後は利用者が所有
    parse.rs         エントリスクリプトの雛形
  example/           ← 動く最小例（第2の利用者として抽象を検証する場）
```

### 利用側レポジトリ

```
your-lang/
  tibineko/gen/            ← T1: コピーのみ
  tibineko/runtime/        ← T1: コピーのみ
  src/parser/
    parse.rs               ← T2: 初回コピー後はあなたのもの
    manual_ast.rs          ← T3: 完全にあなたのもの
    manual_parser.rs       ← T3
    generated_*.rs         ← 生成物（コミット）
  assets/
    grammar.tibineko       ← T3
    tokenmap.csv           ← T3
  gen.mjs                  ← T2: あなたのエントリポイント（~10行）
```

### 所有区分は3つだけ

| 区分 | 対象 | 更新時の扱い |
|---|---|---|
| **T1** コピーのみ・編集禁止 | `tibineko/gen/**`, `tibineko/runtime/**` | **上書き** |
| **T2** seed・初回以降は所有 | `parse.rs`, `gen.mjs` | 手動マージ |
| **T3** 完全に所有 | 文法・トークン表・`manual_*`・`tokens.rs`・`arena.rs` | tibineko は触らない |

ルールはこれだけ。**インターフェースも設定スキーマも契約ファイルもない。**

---

## 5. カスタマイズ＝プラグインではなくフォーク

v1 は `gen_ast_printer.ts` のノード名ハードコードをプラグイン化しようとしていた。
**やめる。** あなたの言語で違うノードを特別扱いしたければ、**あなたのコピーを直接編集する。**

更新を苦痛にしないため、言語固有の箇所に `// TIBINEKO-FORK:` コメントを付ける。
更新時は `grep TIBINEKO-FORK` で再適用箇所が一覧できる。

**実測したフォーク面（合計40行 / 6ファイル）** — 小さいのでフォークは現実的：

| 種類 | 箇所数 | 場所 |
|---|---|---|
| `crate::` パス文字列 | **19行** | `gen_parser.ts`(6), `gen_ast_type.ts`(6), `gen_ast_printer.ts`(3), `gen_tokenmap.ts`(3), `check_ast_size.ts`(1) |
| `$...$` ペイロード判定・除去 | **15行** | `gen_ast_type.ts`(7), `gen_parser.ts`(7), `gen_ast_printer.ts`(1) |
| `#fallback` / `#raw_token` 特別扱い | **2箇所** | `analyze.ts:205`, `analyze.ts:490` |
| プリンタのノード名ハードコード | **4箇所** | `gen_ast_printer.ts:55`(RawDeclaration), `:68`(RawSyntaxToken), `:76`(Identifier), `:78`(StringLiteral) |

---

## 6. 更新方法

```bash
git subtree pull --prefix=tibineko https://github.com/sonneko/tibineko.git main --squash
grep -rn 'TIBINEKO-FORK' tibineko/     # 再適用が必要な箇所を確認
```

T1 は上書きされるので、あなたの編集は T2/T3 に閉じていれば競合しない。
競合したら `grep TIBINEKO-FORK` の一覧を見て手で当てる。それだけ。

---

## 7. やること（3ステップ）

1. **ジェネレータを依存ゼロにする** — import 27+1箇所に `.ts`、10文を `import type` 分割。
   検収: `node_modules` 無しで `node gen/index.ts` と `node gen/self_test.ts` が通る（**実測済み**）。
   → **完了**。`gen/` を参照。`node gen/self_test.ts` = 16 passed / 0 failed。
2. **tibineko レポジトリに `gen/` `runtime/` `seed/` `example/` を配置し、`example/` で最小言語を生成してみる。**
   検収: example が `cargo build` まで通る。
   → **完了**。`example/` は実 Cargo クレートで、13ルールから802行のRustを決定論的に
   生成する。**`cargo build` と両テストスイートは CI で green**（run `39779433721`、
   25 passed / 0 failed）。この環境に cargo がないため CI が唯一のコンパイラ。
3. **hydent-lang を example と同じ構成に寄せる** — 生成物をコミットし、`.gitignore` から外す。
   検収: 新鮮な clone で Node を使わず `cargo build && cargo test` が通る。
   → **未着手**。hydent-lang 側の変更を伴う。
   ただし本レポジトリの `gen/` が hydent-lang の文法に対して
   **元パイプラインと実質同一の出力**を出すことは確認済み（付録参照。4ファイル中
   2ファイルがバイト単位で同一、残り2ファイルの差分は追加した `#![allow(...)]` 行のみ）。

v1 の6フェーズは消えた。

---

## 8. v1 から削ったもの

| v1 で提案していたもの | v2 |
|---|---|
| npm パッケージ発行 | ❌ 削除。ソースをコピーする |
| バックエンドプラグイン機構（`Backend` interface） | ❌ 削除。フォークする |
| `tibineko.toml` 設定スキーマ | ❌ 削除。規約で固定 |
| `$...$` → `manual: true` の形式化 | ❌ 削除。直接編集する |
| ランタイムキットのテンプレート書き出し＋パス書換え | ❌ 削除。`crate::` はそのまま解決する |
| `TIBINEKO_RUNTIME_VERSION` による版ずれ検出 | ❌ 削除。`grep TIBINEKO-FORK` で足りる |
| `tibineko doctor` | ❌ 削除 |
| conformance fixtures | ❌ 削除。`gen/tests.ts`（16件）がそのまま付いてくる |
| 6フェーズ移行計画 | → 3ステップ |

---

## 9. 残る既知の問題（v1 から変わらず、ただし優先度は低い）

vendoring 前提だと「tibineko 側で直すべき制約」ではなく
「あなたのコピーで判断すればよい話」に格下げされるものが多い。

- `TokenSet` はカテゴリごとに u64 ビットマスク。実測 **Keyword 46/64**（残り18）。
  超えたら `ast_node.rs` を你的コピーで `u128` にする（T1 を編集する唯一の想定ケース）。
- `tokenmap.csv` に重複キー `"_"` が2件（後勝ちで上書き）。
- IR の `kind: "hook"` は3ジェネレータが処理するが `analyze.ts` が**一度も生成しない** dead code。
- `#[repr(u8)]` の enum 順序と `tokenmap.csv` の同期は人力。ずれても
  `1 << (keyword as u8)` が黙って壊れる — `example/` に検査を1つ置く価値はある。
- 公開APIに現れる綴り: `Enviroment`(`base_parser.rs:66`), `checkLL2Confilict`(`analyze.ts`),
  `dublicateRemoved`(`gen_ast_type.ts:90`), `grammer.tibineko`。
  **コピーして配る前に直しておく**（利用者の目に触れる名前になるため）。

---

## 付録: 検証記録

### A. 切り出し前（`hydent-lang@bb9a359` に対して実施）

```bash
git clone https://github.com/sonneko/hydent-lang.git
cd hydent-lang/script
rm -rf node_modules            # 依存を消す
# import に .ts を付与(27) / import type 分割(10) / 副作用import(1)
node ./src/index.ts            # → 生成成功
node ./src/self_test.ts        # → 16 passed / 0 failed / exit 0
```

- 生成4ファイルの md5 は `tsx` 実行時と完全一致（§3 変更1）
- `git ls-files` で生成4ファイルが未追跡であることを確認（§1）
- フォーク面 40行は `grep` で実測（§5）

### B. 切り出し後（本レポジトリに対して実施）

```bash
node gen/self_test.ts          # → 16 passed / 0 failed / exit 0（node_modules ゼロ）
cd example && node gen.ts      # → 7ファイル生成、802行のRust
```

- **回帰**: 本レポジトリの `gen/` に hydent-lang の文法とトークン表を与えた出力を、
  改変前ジェネレータの出力と突き合わせた。
  `generated_parser.rs` と `generated_ast_printer.rs` は**バイト単位で同一**。
  `generated_ast.rs` と `generated_tokenmap.rs` の差分は、後から追加した
  `#![allow(...)]` ヘッダのみ（`diff` で確認）。改変前ジェネレータは4ファイル
  すべてを元パイプラインとバイト単位で同一に再現する。
  ```
  72b668719ef438457bcd143c5304e640  generated_parser.rs       (一致)
  2c5f54fab0a5020401d1f46e23f94ecf  generated_ast_printer.rs  (一致)
  416406c581f4f2e76b0aae56b61d24d3  generated_ast.rs          (allow 1行のみ差分)
  0718f789dc687448bf718bb597662e0c  generated_tokenmap.rs     (allow 3行のみ差分)
  ```
  なお hydent-lang の `tokenmap.csv` は重複キー `"_"`（89行目と105行目）を含むため、
  厳格化した `TokenMap.fromCsv` がこれを検出して例外を投げる。重複を除いた104行で実行した。
- **決定論**: `example/` を2回生成し md5 一致を確認。
- **循環検出**: `example/grammar.tibineko` の `Value -> GroupedValue -> Value` が
  `ArenaBox<Value>` に box されること、list 経由の循環は box されないことを確認。
- **TIBINEKO-FORK**: 13マーカー / 6ファイル。`grep -rn TIBINEKO-FORK gen/` で一覧できる。

### 検証手段についての注記

この環境に `cargo` がないため、**Rust 側の検証はすべて GitHub Actions 上で行った**
（ローカルは Node v22.22.3 のみ）。`.github/workflows/ci.yml` が `cargo build`・
`cargo test --lib`・`cargo test --test parse`・clippy・rustfmt を実行し、
run `39779433721` で 3ジョブすべて green（**25 passed / 0 failed**）。

`runtime/*.rs` は hydent-lang の動作実績のあるファイルと**6ファイル中5ファイルが
バイト単位で同一**（`tracer.rs` のみ未使用 import 2行を削除。hydent は crate 全体の
`#![allow(unused)]` でそれを隠している）。

CI が見つけて直したバグ: `manual_parser.rs` の `use IParseErr` 欠落（E0599 ×5）、
内包属性の位置、`Diagnostic` の `Debug` 欠落、`ArenaIterReader::Item` が `&mut T`
であること、コメントを落とすのが tokenizer ではなく `TokenStream` であること。
