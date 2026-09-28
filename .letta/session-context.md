# Letta session context

- project: issue-213-safe-export
- branch: issue-213-safe-export
- retrieved_at: 2026-09-28T01:17:41.162Z

## User

- 日本語で会話。公開物（PRコメント・docs・コミットメッセージ）は英語、重大度を付けて英語で書く。
- 指示は簡潔・命令形。目的と制約だけ渡し、進め方はエージェントに任せる。曖昧でない依頼での確認ダイアログは不要。
- コミット/PRに `Co-Authored-By` を絶対に入れない。
- 「変更しないこと」と言われたら read-only 厳守（前後で `git status` を確認される）。
- issue → worktree → PR の流れを期待。複雑なら `/architecture-planning`、単純なら `/poteto-mode`。
- 出力は要約でなく、原因と優先度付きの指摘を求める。

## Project constraints

- pfl = 静的ハーネス検査CLI（実行しない・read-only・static first・resolution over listing）。不変条件は `CLAUDE.md`、正典は `docs/design/` 配下の設計文書。
- コード変更の前後でテスト/チェック/format/build/knip を実行して確認する。
- `--json` は契約、人間向け出力は契約ではない。`data` への追加フィールドは minor（schema版を上げない）という規則。
- セキュリティ関連の差分は日付付き記録を残し、read-path 一覧を同一変更で更新する。
- レビューは CRITICAL が無くなるまで往復（Codex、上限時は Claude Code にフォールバック）。指摘は CRITICAL/CONSIDER/MINOR 分類。
- このチェックアウトは `git add -A` 禁止（`.letta/` など未追跡物がある）。

## Open questions

- issue #213 (safe-export) の中身は memory に記録なし。着手前に issue 本文と設計文書を読む必要あり。
- #165（report/list/graph の `scope`）は未解決のまま。列構成の決定を #167 と切り離さない方針。
- #187: `skills/pfl/references/json-contract.md` と SKILL.md のドリフト（element `path` が未反映）。
- memory 上の pfl は v1.0.0 時点の記録で、現在の 1.1.0 までの差分は未記録。
