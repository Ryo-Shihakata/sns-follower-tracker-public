# collector: 自宅サーバー (Ubuntu Server + Docker) で1回走って終了するコンテナ。
# systemd timer (deploy/systemd/) や `docker compose run --rm collector` から起動する想定。
FROM python:3.12-slim

# curl_cffi の同梱バイナリ (manylinux wheel) を使うのでビルドツールは基本不要だが、
# 万一 wheel が無い環境向けに最小限のビルド依存だけ入れておく。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

WORKDIR /app

# 依存だけ先にインストールしてレイヤーキャッシュを効かせる。
# 本番デプロイ先はこのイメージのみ (docs/implementation-plan.md §5.2 手段3) なので
# `stealth` extra (scrapling+patchright) は常時同梱する。実行するかどうかは
# IG_ENABLE_STEALTH (既定オフ) でランタイム側から切り替える。
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra stealth

# 手段3 (ステルスブラウザ) 用の Chromium 本体。--with-deps が Debian 系に必要な
# apt パッケージ (libnss3 等) も併せて入れる。
# `uv run` ではなく venv の python を直接呼ぶ: `uv run` はプロジェクト自体の同期・ビルドも
# 試みるため、README.md/src をまだ COPY していないこの時点で呼ぶとビルドに失敗する。
RUN .venv/bin/python -m patchright install --with-deps chromium

COPY README.md ./
COPY src ./src
RUN uv sync --frozen --no-dev --extra stealth

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1

# 収集結果の保存先。docker-compose.yml で ./data:/data をマウントする想定。
VOLUME ["/data"]

ENTRYPOINT ["python", "-m", "collector.main"]
