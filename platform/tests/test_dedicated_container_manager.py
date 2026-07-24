import sys
import types
from types import SimpleNamespace

from app.config import Settings

if "docker" not in sys.modules:
    docker_stub = types.ModuleType("docker")
    docker_stub.DockerClient = object
    docker_stub.from_env = lambda: None
    docker_stub.types = types.SimpleNamespace(Mount=lambda *args, **kwargs: None)
    docker_stub.models = types.SimpleNamespace(containers=types.SimpleNamespace(Container=object))
    sys.modules["docker"] = docker_stub

    errors_module = types.ModuleType("docker.errors")
    errors_module.APIError = RuntimeError
    errors_module.NotFound = RuntimeError
    sys.modules["docker.errors"] = errors_module

from app.container import manager


class DummyContainer:
    def __init__(self, ports=None):
        self.attrs = {"NetworkSettings": {"Ports": ports or {}}}


def test_settings_expose_dedicated_container_prefix_fields():
    settings = Settings()

    assert settings.dedicated_runtime_container_name_prefix == "hermes-user"
    assert settings.dedicated_runtime_data_volume_prefix == "hermes-data"
    assert settings.hermes_api_toolsets == "terminal,file,skills"


def test_openclaw_runtime_uses_legacy_defaults(monkeypatch):
    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "openclaw")
    monkeypatch.setattr(
        manager.settings,
        "dedicated_runtime_container_name_prefix",
        "openclaw-user",
    )
    monkeypatch.setattr(manager.settings, "dedicated_runtime_data_volume_prefix", "openclaw-data")
    monkeypatch.setattr(manager.settings, "user_container_bind_ip", "0.0.0.0")

    assert manager._container_name("abc12345") == "openclaw-user-abc12345"
    assert manager._data_volume_name("abc12345") == "openclaw-data-abc12345"
    assert manager._runtime_published_ports() == {
        "5900/tcp": ("0.0.0.0", None),
        "30000/tcp": ("0.0.0.0", None),
    }
    assert manager._runtime_preferred_ports(5901, 30001) == {
        "5900/tcp": ("0.0.0.0", 5901),
        "30000/tcp": ("0.0.0.0", 30001),
    }


def test_openclaw_model_config_patch_aligns_main_agent_with_platform_default():
    config = {
        "agents": {
            "defaults": {"model": "platform-proxy/old/default"},
            "list": [
                {"id": "main", "model": "platform-proxy/dashscope/MiniMax/MiniMax-M2.7"},
                {"id": "doctor", "model": "platform-proxy/kimi/kimi-k2.5"},
            ],
        }
    }

    changed = manager._apply_openclaw_model_config(config, "deepseek/deepseek-chat")

    assert changed is True
    assert config["agents"]["defaults"]["model"] == "platform-proxy/deepseek/deepseek-chat"
    assert config["agents"]["list"][0]["model"] == "platform-proxy/deepseek/deepseek-chat"
    assert config["agents"]["list"][1]["model"] == "platform-proxy/kimi/kimi-k2.5"


def test_hermes_runtime_switches_internal_port_publish(monkeypatch):
    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "hermes")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_internal_port", 18123)
    monkeypatch.setattr(manager.settings, "user_container_bind_ip", "127.0.0.1")

    assert manager._internal_port() == 18123
    assert manager._runtime_command() == ["gateway", "run"]
    assert manager._runtime_published_ports() == {"18123/tcp": ("127.0.0.1", None)}
    assert manager._runtime_preferred_ports(5901, 30001) is None



def test_hermes_runtime_environment_enables_api_server(monkeypatch):
    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "hermes")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_internal_port", 18123)
    monkeypatch.setattr(manager.settings, "dedicated_hermes_api_key", "bridge-key")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_default_api_key", "proxy-key")
    monkeypatch.setattr(manager.settings, "default_model", "claude-sonnet-4-5")
    monkeypatch.setattr(manager.settings, "hermes_api_toolsets", "none")
    monkeypatch.setattr(manager.settings, "container_tz", "Asia/Shanghai")
    monkeypatch.setattr(
        manager.settings,
        "dedicated_hermes_user_site_path",
        "/opt/data/.local/lib/python3.13/site-packages",
    )

    env = manager._runtime_environment("container-token", "sso-token")

    assert env["NANOBOT_PROXY__URL"] == "http://gateway:8080/llm/v1"
    assert env["NANOBOT_PROXY__TOKEN"] == "container-token"
    assert env["NANOBOT_AGENTS__DEFAULTS__MODEL"] == "claude-sonnet-4-5"
    assert env["PYTHONUNBUFFERED"] == "1"
    assert env["API_SERVER_ENABLED"] == "true"
    assert env["API_SERVER_HOST"] == "0.0.0.0"
    assert env["API_SERVER_PORT"] == "18123"
    assert env["API_SERVER_KEY"] == "bridge-key"
    assert env["GATEWAY_ALLOW_ALL_USERS"] == "true"
    assert env["OPENAI_API_KEY"] == "proxy-key"
    assert env["HERMES_API_TOOLSETS"] == "none"
    assert env["INFOX_MED_TOKEN"] == "sso-token"
    # Persisted user-site packages + default --user installs (see _runtime_environment).
    assert env["PIP_USER"] == "1"
    assert env["PIP_BREAK_SYSTEM_PACKAGES"] == "1"
    assert env["PYTHONPATH"] == "/opt/data/.local/lib/python3.13/site-packages"
    assert "BRIDGE_ENABLE_CHANNELS" not in env


def test_build_hermes_runtime_files_support_platform_default_model(monkeypatch):
    monkeypatch.setattr(manager.settings, "default_model", "claude-sonnet-4-5")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_default_provider", "custom")
    monkeypatch.setattr(
        manager.settings,
        "dedicated_hermes_default_base_url",
        "http://gateway:8080/llm/v1",
    )
    monkeypatch.setattr(manager.settings, "dedicated_hermes_api_key", "bridge-key")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_default_api_key", "proxy-key")
    monkeypatch.setattr(manager.settings, "hermes_api_toolsets", "none")
    monkeypatch.setattr(manager.settings, "hermes_reasoning_effort", "none")
    monkeypatch.setattr(manager.settings, "hermes_service_tier", "")

    config_yaml = manager._build_hermes_config_yaml()
    env_file = manager._build_hermes_env_file()

    assert 'default: claude-sonnet-4-5' in config_yaml
    assert 'provider: custom' in config_yaml
    assert 'base_url: http://gateway:8080/llm/v1' in config_yaml
    assert 'agent:' in config_yaml
    assert 'reasoning_effort: none' in config_yaml
    assert "service_tier: ''" in config_yaml
    assert 'platform_toolsets:' in config_yaml
    assert 'api_server: []' in config_yaml
    assert 'API_SERVER_KEY=bridge-key' in env_file
    assert 'GATEWAY_ALLOW_ALL_USERS=true' in env_file
    assert 'OPENAI_API_KEY=proxy-key' in env_file
    assert 'HERMES_API_TOOLSETS=none' in env_file
    assert 'HERMES_REASONING_EFFORT=none' in env_file
    assert 'HERMES_SERVICE_TIER=' in env_file


def test_write_hermes_runtime_files_repairs_data_volume_ownership(monkeypatch):
    class RecordingContainer:
        def __init__(self):
            self.attrs = {
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": "hermes-anonymous-data",
                        "Destination": "/opt/data",
                    }
                ]
            }
            self.archives = []

        def put_archive(self, path, data):
            self.archives.append((path, data))
            return True

    class RecordingContainerRunner:
        def __init__(self):
            self.calls = []

        def run(self, **kwargs):
            self.calls.append(kwargs)
            return SimpleNamespace(id="repair-container")

    runner = RecordingContainerRunner()
    monkeypatch.setattr(manager, "_runtime_image", lambda: "nanobot-hermes-agent:latest")
    monkeypatch.setattr(manager, "_docker", lambda: SimpleNamespace(containers=runner))
    monkeypatch.setattr(
        manager.docker.types,
        "Mount",
        lambda target, source, type: {"target": target, "source": source, "type": type},
    )

    container = RecordingContainer()

    manager._write_hermes_runtime_files(container)

    assert container.archives[0][0] == "/opt/data"
    assert runner.calls == [
        {
            "image": "nanobot-hermes-agent:latest",
            "entrypoint": "chown",
            "command": ["-R", "hermes:hermes", "/opt/data"],
            "mounts": [{"target": "/opt/data", "source": "hermes-anonymous-data", "type": "volume"}],
            "remove": True,
        }
    ]


def test_hermes_api_toolsets_support_skills_and_full_modes(monkeypatch):
    monkeypatch.setattr(manager.settings, "hermes_api_toolsets", "skills")
    config_yaml = manager._build_hermes_config_yaml()
    assert "- skills" in config_yaml

    monkeypatch.setattr(manager.settings, "hermes_api_toolsets", "full")
    config_yaml = manager._build_hermes_config_yaml()
    assert "- hermes-api-server" in config_yaml


def test_published_port_bindings_follow_runtime_backend(monkeypatch):
    openclaw_container = DummyContainer(
        {
            "5900/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5901"}],
            "30000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "30001"}],
        }
    )
    hermes_container = DummyContainer(
        {
            "18123/tcp": [{"HostIp": "127.0.0.1", "HostPort": "40123"}],
        }
    )

    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "openclaw")
    assert manager._published_port_bindings(openclaw_container) == (
        ("0.0.0.0", "5901"),
        ("0.0.0.0", "30001"),
    )

    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "hermes")
    monkeypatch.setattr(manager.settings, "dedicated_hermes_internal_port", 18123)
    assert manager._published_port_bindings(hermes_container) == (
        ("", ""),
        ("127.0.0.1", "40123"),
    )


def test_hermes_runtime_rejects_legacy_openclaw_container(monkeypatch):
    legacy = SimpleNamespace(
        attrs={
            "Config": {
                "Image": "openclaw:latest",
                "Entrypoint": ["/entrypoint.sh"],
                "Cmd": ["node", "bridge/dist/bridge/start.js"],
                "Env": ["BRIDGE_ENABLE_CHANNELS=1"],
            }
        }
    )
    hermes = SimpleNamespace(
        attrs={
            "Config": {
                "Image": "nanobot-hermes-agent:latest",
                "Entrypoint": ["/opt/hermes/docker/entrypoint.sh"],
                "Cmd": ["gateway", "run", "-v"],
                "Env": ["API_SERVER_ENABLED=true", "HERMES_HOME=/opt/data"],
            }
        }
    )
    hermes_s6 = SimpleNamespace(
        attrs={
            "Config": {
                "Image": "nanobot-hermes-agent:latest",
                "Entrypoint": ["/init", "/opt/hermes/docker/main-wrapper.sh"],
                "Cmd": ["gateway", "run", "-v"],
                "Env": ["API_SERVER_ENABLED=true", "HERMES_HOME=/opt/data"],
            }
        }
    )

    monkeypatch.setattr(manager.settings, "dedicated_runtime_backend", "hermes")

    assert manager._container_matches_runtime(legacy) is False
    assert manager._container_matches_runtime(hermes) is True
    assert manager._container_matches_runtime(hermes_s6) is True
