"""Settings.from_env の Graph API アカウント解決のテスト。

- レガシー IG_GRAPH_TOKEN/IG_GRAPH_USER_ID は DEFAULT_IG_GRAPH_HANDLE に紐付く。
- IG_GRAPH_ACCOUNTS + IG_GRAPH_TOKEN_<HANDLE>/IG_GRAPH_USER_ID_<HANDLE> で
  任意 handle を後付けできる (env 2 つ足すだけ)。
- 片方だけの handle は黙って除外。handle は正規化して env サフィックスに使う。
"""

from __future__ import annotations

import pytest

from collector.config import DEFAULT_IG_GRAPH_HANDLE, Settings

# from_env が拾いうる Graph 系環境変数はテストごとに掃除する。
_GRAPH_ENV_PREFIXES = ("IG_GRAPH_TOKEN", "IG_GRAPH_USER_ID", "IG_GRAPH_ACCOUNTS")


@pytest.fixture(autouse=True)
def _clear_graph_env(monkeypatch: pytest.MonkeyPatch):
    import os

    for key in list(os.environ):
        if key.startswith(_GRAPH_ENV_PREFIXES):
            monkeypatch.delenv(key, raising=False)


def _from_env() -> Settings:
    # 実在しない dotenv を指定して cwd の .env を読み込ませない。
    return Settings.from_env(dotenv_path="__nonexistent_dotenv__.env")


def test_legacy_single_token_maps_to_default_handle(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("IG_GRAPH_TOKEN", "legacy-token")
    monkeypatch.setenv("IG_GRAPH_USER_ID", "17841400000000000")
    accounts = _from_env().ig_graph_accounts
    assert accounts == {
        DEFAULT_IG_GRAPH_HANDLE: {"token": "legacy-token", "ig_user_id": "17841400000000000"}
    }


def test_no_graph_env_yields_empty_map():
    assert _from_env().ig_graph_accounts == {}


def test_ig_graph_accounts_adds_per_handle(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("IG_GRAPH_ACCOUNTS", "example_account_a, example_account_b")
    monkeypatch.setenv("IG_GRAPH_TOKEN_EIZOCREATOR_PROJECT", "tok-a")
    monkeypatch.setenv("IG_GRAPH_USER_ID_EIZOCREATOR_PROJECT", "111")
    monkeypatch.setenv("IG_GRAPH_TOKEN_HIGASHIFUKUOKA_SEITOKAI", "tok-b")
    monkeypatch.setenv("IG_GRAPH_USER_ID_HIGASHIFUKUOKA_SEITOKAI", "222")
    accounts = _from_env().ig_graph_accounts
    assert accounts == {
        "example_account_a": {"token": "tok-a", "ig_user_id": "111"},
        "example_account_b": {"token": "tok-b", "ig_user_id": "222"},
    }


def test_partial_per_handle_is_ignored(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("IG_GRAPH_ACCOUNTS", "only_token_handle")
    monkeypatch.setenv("IG_GRAPH_TOKEN_ONLY_TOKEN_HANDLE", "tok")
    # user_id を設定しない -> 除外される
    assert _from_env().ig_graph_accounts == {}


def test_per_handle_overrides_legacy_for_same_handle(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("IG_GRAPH_TOKEN", "legacy-token")
    monkeypatch.setenv("IG_GRAPH_USER_ID", "legacy-user")
    monkeypatch.setenv("IG_GRAPH_ACCOUNTS", DEFAULT_IG_GRAPH_HANDLE)
    monkeypatch.setenv(f"IG_GRAPH_TOKEN_{DEFAULT_IG_GRAPH_HANDLE.upper()}", "new-token")
    monkeypatch.setenv(f"IG_GRAPH_USER_ID_{DEFAULT_IG_GRAPH_HANDLE.upper()}", "new-user")
    accounts = _from_env().ig_graph_accounts
    assert accounts[DEFAULT_IG_GRAPH_HANDLE] == {"token": "new-token", "ig_user_id": "new-user"}


def test_handle_with_dot_is_normalized(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("IG_GRAPH_ACCOUNTS", "some.handle")
    monkeypatch.setenv("IG_GRAPH_TOKEN_SOME_HANDLE", "tok")
    monkeypatch.setenv("IG_GRAPH_USER_ID_SOME_HANDLE", "333")
    accounts = _from_env().ig_graph_accounts
    assert accounts == {"some.handle": {"token": "tok", "ig_user_id": "333"}}
