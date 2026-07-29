"""Regression coverage for persistent user-installed CLI discovery."""

from pathlib import Path

import pytest


HERMES_ROOT = Path(__file__).resolve().parent.parent
PERSISTENT_CLI_PATHS = (
    "/opt/data/.npm-global/bin",
    "/opt/data/bin",
    "/opt/data/.local/bin",
)


@pytest.mark.parametrize("dockerfile_name", ("Dockerfile", "Dockerfile.bridge"))
def test_dockerfile_exposes_persistent_cli_paths(dockerfile_name: str) -> None:
    dockerfile = (HERMES_ROOT / dockerfile_name).read_text(encoding="utf-8")
    env_path = next(
        line for line in dockerfile.splitlines() if line.startswith("ENV PATH=")
    )

    for path in PERSISTENT_CLI_PATHS:
        assert path in env_path


@pytest.mark.parametrize("dockerfile_name", ("Dockerfile", "Dockerfile.bridge"))
def test_login_shell_restores_persistent_cli_paths(dockerfile_name: str) -> None:
    dockerfile = (HERMES_ROOT / dockerfile_name).read_text(encoding="utf-8")
    profile_setup = next(
        line
        for line in dockerfile.splitlines()
        if "/etc/profile.d/hermes.sh" in line
    )

    for path in PERSISTENT_CLI_PATHS:
        assert path in profile_setup
