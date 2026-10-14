# CI/CD（GitHub Actions によるデプロイ）

worker と collector、それぞれを対象パスの変更をトリガーに自動デプロイする。
2つの workflow は独立していて、片方の変更がもう片方をデプロイすることはない。

- `.github/workflows/deploy-worker.yml` — Cloudflare Workers(`worker/`)
- `.github/workflows/deploy-collector.yml` — 自宅VM上のcollector(`collector/`)

いずれも `workflow_dispatch` で手動実行もできる（Actions タブ → 該当workflow → Run workflow）。

> **secrets はコード側に書かれていない。** ユーザーがリポジトリの
> **Settings → Secrets and variables → Actions** で下記を登録する必要がある。
> 登録するまでどちらの workflow も失敗する。

## 1. deploy-worker.yml

トリガー: `main` への push かつ `worker/**` に変更があったとき（+ 手動実行）。

処理: checkout → Node.js セットアップ → `npm ci`（`worker/`）→
`wrangler d1 migrations apply sns-follower-tracker --remote` → `wrangler deploy`。
D1 migrations適用とdeployは `cloudflare/wrangler-action@v3` の1ステップ内で順に実行する
（同じ `workingDirectory: worker` で完結させるため）。

### 必要な GitHub Secrets

| Secret名 | 用途 | 取得方法 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | wrangler の認証 | Cloudflareダッシュボード → 右上プロフィール → **My Profile → API Tokens → Create Token** → 「Edit Cloudflare Workers」テンプレートをベースに、少なくとも **Account: Workers Scripts: Edit** と **Account: D1: Edit** の権限を持つトークンを作成。対象アカウントをこのプロジェクトのアカウントに限定するのを推奨 |
| `CLOUDFLARE_ACCOUNT_ID` | 対象アカウントの指定 | Cloudflareダッシュボードの任意のWorkers/D1ページ右側サイドバーに表示される Account ID をコピー |

## 2. deploy-collector.yml

トリガー: `main` への push かつ `collector/**` に変更があったとき（+ 手動実行）。

### 課題: GitHub-hosted runner から自宅VMへの到達性

collectorが動く自宅Ubuntu VMは `192.168.x.x` の家庭内LANにあり、
GitHub-hosted runnerから直接SSHできない。外部からは **Tailscale** 経由でのみ到達可能。
そのため workflow 内で `tailscale/github-action@v4` を使い、runner自身を一時的に
tailnetへ参加させてからVMへ `rsync` + `ssh` で同期・ビルドする。

処理:
1. `tailscale/github-action@v4` でrunnerをtailnetに参加（OAuth client credentials）
2. `webfactory/ssh-agent` でVM用SSH秘密鍵をagentにロード
3. `ssh-keyscan` でVMのホスト鍵を`known_hosts`に登録
4. `rsync -az --delete` で `collector/` をVMへ同期
   - **除外**: `.env`（サーバ側の秘密を上書きしない）、`data/`（ローカルDBを壊さない）、
     `__pycache__/`、`.venv/`、`*.sqlite` / `*.sqlite3`
5. `ssh` でVMに入り、同期先ディレクトリで `docker compose build`

collectorはワンショットコンテナ（`docker-compose.yml`参照。systemd timerから
`docker compose run --rm collector`で起動する運用）なので、このworkflowは
**イメージの再ビルドまで**を行う。次回のtimer起動から新しいコードが使われる。

### 必要な GitHub Secrets

| Secret名 | 用途 | 取得方法 |
|---|---|---|
| `TS_OAUTH_CLIENT_ID` | Tailscale OAuth client ID | [Tailscale管理コンソール](https://login.tailscale.com/admin/settings/oauth) → **OAuth clients → Generate OAuth client**。スコープは `Auth Keys` を **Write** 権限で有効化 |
| `TS_OAUTH_SECRET` | Tailscale OAuth client secret | 上記OAuth client生成時に表示されるsecret（再表示不可なので発行直後に控える） |
| `VM_SSH_KEY` | VMへSSHするための秘密鍵（PEM形式全文） | ローカルで `ssh-keygen -t ed25519 -f deploy_key -C "gh-actions-collector"` のようにデプロイ専用の鍵ペアを新規作成し、秘密鍵の中身をそのままsecretに登録 |
| `VM_HOST` | VMのTailscaleホスト名（またはTailscale IP） | Tailscale管理コンソールの Machines 一覧に表示されるVMのMagicDNS名（例: `collector-host.tailxxxx.ts.net`）、またはVMで `tailscale ip -4` の出力 |
| `VM_USER` | SSHログインユーザー名 | 例: `collector-host`。VM上の実際のログインユーザー名に合わせる |

上で生成した公開鍵（`deploy_key.pub`）は、VM側の対象ユーザーの
`~/.ssh/authorized_keys` に追記しておく（VM上で作業。GitHub Actionsからは行わない）。

```bash
# VM側で一度だけ実行
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo "<公開鍵の中身>" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

また、VM上の同期先ディレクトリ（`/home/<VM_USER>/apps/sns-follower-tracker/collector/`）は
事前にVM側で作成し、`.env`（`collector/.env.example`参照）を配置しておくこと。
このディレクトリが存在しない、または `.env` が無い状態でworkflowを回すと、
`rsync`は成功してもcollector自体は起動できない。

> 現状のsystemd unit例（`collector/deploy/systemd/collector.service`）は
> `WorkingDirectory=/opt/sns-follower-tracker/collector` を指しているため、
> `/home/<VM_USER>/apps/...` を使う場合はunitファイルのパスも合わせて書き換えること。

## Tailscale方式 vs self-hosted runner

上記はTailscale経由でGitHub-hosted runnerからVMへ到達する方式。もう一つの選択肢として、
**VM自体をGitHub Actions self-hosted runnerにする**方式もある。

| | Tailscale方式（採用） | self-hosted runner方式（代替） |
|---|---|---|
| 実行環境 | GitHub-hosted runner（使い捨て） | VM自体が常駐runner |
| VM側の常駐プロセス | Tailscaleクライアントのみ（既存） | `actions-runner`サービスを追加で常駐させる必要あり |
| セットアップ | Tailscale ACLでtag付けとOAuth clientの発行のみ | VMに `actions-runner` をインストール・登録・サービス化 |
| セキュリティ面 | runnerは実行毎に使い捨て、tailnetへの参加も一時的 | VMがGitHubからのジョブを常時受け付ける待受プロセスを持つ（攻撃対象面が増える） |
| GitHub側の要求 | 追加コスト無し（public/privateどちらでも動く） | self-hosted runnerはpublicリポジトリでは推奨されない（fork PRからの任意コード実行リスク） |
| 向いているケース | 今回のようにVMが基本イントラ限定・Tailscaleが既に使える場合 | ネットワーク的にTailscale導入が難しい／runnerを複数workflowで使い回したい場合 |

このプロジェクトは非公開リポジトリかつVMがTailscale管理下にあるため、Tailscale方式を採用した。
self-hosted runner方式に切り替える場合は、VM上で
[Actions runnerのセットアップ手順](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/adding-self-hosted-runners)
に従いrunnerを登録し、`deploy-collector.yml`の`runs-on`を`self-hosted`に変更、
Tailscale/SSH関連のステップを削除して`rsync`の代わりに`checkout`済みのファイルを
直接使う形に書き換える。
