# CLAUDE.md — sns-follower-tracker

## プロジェクト概要

SNS フォロワー推移トラッカー。自宅サーバー(Ubuntu+Docker)の Python collector が
Instagram 等を未ログイン取得し、Cloudflare Workers(Hono)+D1 に蓄積、
Workers 上のダッシュボードでグラフ表示する。

**実装前に必ず [docs/implementation-plan.md](docs/implementation-plan.md) を読むこと。**
設計判断(§1 決定事項)は grill-me で合意済み。勝手に再解釈しない。

## 構成

- `worker/` — TypeScript + Hono + D1。API 契約は計画書 §5.5、スキーマは §4.1
- `collector/` — Python (uv 管理) + Scrapling。プラグイン式 collector (§5.1)
- 両者の境界は HTTP API のみ。worker と collector は互いのコードに依存しない

## 規約

- コミット: Conventional Commits (`feat:` `fix:` など)。要約1行、本文日本語可
- 秘密情報 (`.env`, secret) はコミット禁止。`.env.example` のみ
- Instagram 取得の礼儀ルール (§5.2: jitter、全滅即中断、リトライ最大1回) は必ず守る
- パース処理には固定フィクスチャのユニットテストを必ず付ける
