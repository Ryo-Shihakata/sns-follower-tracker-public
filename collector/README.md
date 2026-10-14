# collector

SNS フォロワー推移トラッカーの自宅サーバー側コンポーネント。Instagram(未ログイン) /
YouTube(公式 API) からフォロワー数+最新12投稿の公開指標を取得し、ローカル SQLite に
記録しつつ Cloudflare Workers の `/ingest` へ送信する。設計の全体像・データモデル・
API 契約は `docs/implementation-plan.md`(リポジトリルート) を参照。

## ローカル開発 (Windows/macOS/Linux 共通)

```bash
cd collector
uv sync                 # 依存インストール (venv は collector/.venv に作られる)
uv run pytest           # ユニット/統合テスト (実ネットワークアクセスなし)
uv run pytest ../scripts/tests   # scripts/resync_d1_from_local.py のテスト

# ドライラン (モック値でローカル SQLite に保存するだけ。送信なし)
uv run python -m collector.main --dry-run

# 本番相当のラン (WORKERS_BASE_URL / INGEST_SECRET が必須)
cp .env.example .env    # 値を埋める
set -a && source .env && set +a   # .env を環境変数として読み込む (bash の場合)
uv run python -m collector.main
```

`--dry-run` 以外の本番ランは Instagram に実アクセスするため、開発機では
`--dry-run` かフィクスチャ経由のテストだけに留めること。

## ステルスブラウザ (手段3) を有効化する場合

既定では入れていない (`playwright`/`patchright` 等の重い依存とブラウザバイナリの
別途インストールが必要になるため)。有効化する場合のみ:

```bash
uv sync --extra stealth
uv run python -m scrapling install    # ブラウザバイナリ導入 (任意・現状 collector 本体は未対応)
```

現時点では `platforms/instagram.py` の手段3はスタブ (`NotImplementedError`) なので、
このオプションを入れても即座に使えるわけではない (フェーズ6で実装予定)。

## Docker での実行

```bash
cd collector
cp .env.example .env    # 値を埋める
docker compose build
docker compose run --rm collector            # ドライランではなく本番ラン
docker compose run --rm collector --dry-run  # 動作確認だけしたい場合
```

`./data` ディレクトリがコンテナの `/data` にマウントされ、`LOCAL_DB_PATH=/data/local.sqlite`
(既定値、`.env.example` 参照) がそこに永続化される。

## Ubuntu Server への配置 (systemd timer で1日3回自動実行)

前提: Ubuntu Server 上に Docker / Docker Compose plugin (`docker compose`) が導入済み。

1. リポジトリを配置する (パスは任意。以下は `deploy/systemd/*.service` の既定値に合わせた例):
   ```bash
   sudo mkdir -p /opt/sns-follower-tracker
   sudo chown "$USER":"$USER" /opt/sns-follower-tracker
   git clone <this-repo-url> /opt/sns-follower-tracker
   cd /opt/sns-follower-tracker/collector
   cp .env.example .env
   $EDITOR .env   # WORKERS_BASE_URL / INGEST_SECRET / YOUTUBE_API_KEY 等を設定
   mkdir -p data
   docker compose build
   ```
2. 動作確認 (1回だけ手動実行):
   ```bash
   docker compose run --rm collector --dry-run
   docker compose run --rm collector
   ```
3. systemd unit を配置する。`WorkingDirectory` を実際の配置パスに合わせて
   `deploy/systemd/collector.service` を編集してから:
   ```bash
   sudo cp deploy/systemd/collector.service deploy/systemd/collector.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now collector.timer
   ```
4. 確認:
   ```bash
   systemctl list-timers collector.timer
   sudo systemctl start collector.service   # 即時に1回実行して確認
   journalctl -u collector.service -n 100 --no-pager
   ```

`collector.timer` は 02:15 / 10:15 / 18:15 (マシンのローカルタイムゾーン) に
`RandomizedDelaySec=600` の揺らぎを付けて起動する (docs/implementation-plan.md §8 トラックC3)。

## D1 が失われたときの復旧 (resync)

ローカル SQLite の送信履歴 (outbox) から Workers `/ingest` へ再送し、D1 を再構築できる。
D1 側は UNIQUE 制約 + `ON CONFLICT DO NOTHING` で冪等なので、同じデータを再送しても壊れない。

```bash
cd collector
uv run python ../scripts/resync_d1_from_local.py \
  --local-db /data/local.sqlite \
  --workers-base-url https://<your-worker>.workers.dev \
  --ingest-secret "$INGEST_SECRET" \
  --dry-run     # まず件数だけ確認してから --dry-run を外して本実行する
```

## 既知の逸脱・未実装 (フェーズ6予定)

- Instagram の手段2 (HTML 埋め込み抽出) / 手段3 (ステルスブラウザ) は
  `platforms/instagram.py` にスタブ (`NotImplementedError`) のみ。手段1が
  ブロックされ始めたら実装する。
- TLS/JA3 偽装は計画書が指定する Scrapling の Fetcher ではなく `curl_cffi` を
  直接使っている (`platforms/instagram.py` 冒頭のコメント参照)。Scrapling の
  非ブラウザ Fetcher が import 時点で playwright/patchright に依存しており、
  重い `fetchers` extra を必須にしてしまうため。
- `instagram_graph.py` (管理アカウント向け公式 Graph API) は未着手 (フェーズ6)。
