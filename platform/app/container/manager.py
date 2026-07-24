"""Docker container lifecycle management for per-user dedicated runtime instances."""

from __future__ import annotations

import io
import json
import secrets
import tarfile
import time

import docker
import yaml
from docker.errors import APIError as DockerAPIError
from docker.errors import NotFound as DockerNotFound
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db.models import Container, User, UserPortBinding

_client: docker.DockerClient | None = None


def _docker() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def get_docker_container(container_id_or_name: str) -> docker.models.containers.Container:
    return _docker().containers.get(container_id_or_name)


def _ensure_network() -> None:
    """Create the internal Docker network if it doesn't exist."""
    client = _docker()
    try:
        client.networks.get(settings.container_network)
    except DockerNotFound:
        client.networks.create(
            settings.container_network,
            driver="bridge",
            internal=False,  # allow internet access for tool downloads
        )


def _published_binding(container: docker.models.containers.Container, container_port: str) -> tuple[str, str]:
    """Return (host_ip, host_port) for a published container port."""
    ports = container.attrs.get("NetworkSettings", {}).get("Ports", {}) or {}
    bindings = ports.get(container_port) or []
    if not bindings:
        return "", ""
    host_ip = bindings[0].get("HostIp", "") or ""
    host_port = bindings[0].get("HostPort", "") or ""
    return host_ip, host_port


def _is_host_port_in_use(client: docker.DockerClient, host_port: int) -> bool:
    """Return True if any container currently publishes the given host port."""
    port_str = str(host_port)
    for c in client.containers.list(all=True):
        ports = c.attrs.get("NetworkSettings", {}).get("Ports", {}) or {}
        for bindings in ports.values():
            for binding in (bindings or []):
                if (binding.get("HostPort") or "") == port_str:
                    return True
    return False


def _runtime_backend() -> str:
    return (settings.dedicated_runtime_backend or "openclaw").strip().lower()


def _container_name(short_id: str) -> str:
    prefix = (settings.dedicated_runtime_container_name_prefix or "openclaw-user").strip() or "openclaw-user"
    return f"{prefix}-{short_id}"


def _data_volume_name(short_id: str) -> str:
    prefix = (settings.dedicated_runtime_data_volume_prefix or "openclaw-data").strip() or "openclaw-data"
    return f"{prefix}-{short_id}"


def _hermes_home_volume_name(short_id: str) -> str:
    return f"{_data_volume_name(short_id)}-home"


def _internal_port() -> int:
    if _runtime_backend() == "hermes":
        return settings.dedicated_hermes_internal_port
    return 18080


def _runtime_image() -> str:
    if _runtime_backend() == "hermes":
        return settings.hermes_image
    return settings.openclaw_image


def _runtime_mount_target() -> str:
    if _runtime_backend() == "hermes":
        return "/workspace"
    return "/root/.openclaw"


def _build_runtime_mounts(data_vol: str, short_id: str) -> list:
    """Build volume mounts for the user container.

    Hermes containers get two named volumes:
      - ``/workspace``   — user workspace (skills, files, sessions)
      - ``/opt/data``    — HERMES_HOME (profiles, config, skills cache)
    """
    mounts = [
        docker.types.Mount(_runtime_mount_target(), data_vol, type="volume"),
    ]
    if _runtime_backend() == "hermes":
        home_vol = _hermes_home_volume_name(short_id)
        mounts.append(docker.types.Mount("/opt/data", home_vol, type="volume"))
    return mounts


def _runtime_command() -> list[str]:
    if _runtime_backend() == "hermes":
        return ["gateway", "run"]
    return ["node", "bridge/dist/bridge/start.js"]


def _runtime_environment(container_token: str, sso_token: str | None) -> dict[str, str]:
    env = {
        "NANOBOT_PROXY__URL": "http://gateway:8080/llm/v1",
        "NANOBOT_PROXY__TOKEN": container_token,
        "NANOBOT_AGENTS__DEFAULTS__MODEL": settings.default_model,
        "TZ": settings.container_tz,
    }
    if _runtime_backend() == "openclaw":
        env["BRIDGE_ENABLE_CHANNELS"] = "1"
    else:
        env.update(
            {
                "PYTHONUNBUFFERED": "1",
                "API_SERVER_ENABLED": "true",
                "API_SERVER_HOST": "0.0.0.0",
                "API_SERVER_PORT": str(settings.dedicated_hermes_internal_port),
                "API_SERVER_KEY": settings.dedicated_hermes_api_key,
                "GATEWAY_ALLOW_ALL_USERS": "true",
                "OPENAI_API_KEY": settings.dedicated_hermes_default_api_key,
                "HERMES_API_TOOLSETS": settings.hermes_api_toolsets,
                "HERMES_REASONING_EFFORT": settings.hermes_reasoning_effort,
                "HERMES_SERVICE_TIER": settings.hermes_service_tier,
                "HERMES_YOLO_MODE": "true",
                # hermes runs an isolated venv (include-system-site-packages=false,
                # ENABLE_USER_SITE=False): `pip install` lands in the system site (invisible
                # to the venv), `pip install --user` in the user site (also invisible), and
                # venv installs land in the ephemeral container layer. Three envs make a
                # user's `pip install xxx` Just Work and survive rebuilds:
                #   PIP_USER=1                   -> install into the user site
                #   PIP_BREAK_SYSTEM_PACKAGES=1  -> bypass PEP 668 (system pip is externally
                #                                  managed; user site is safe, single-user box)
                #   PYTHONPATH                   -> expose the persisted user site to the venv
                # User site is /opt/data/.local (hermes HOME per Dockerfile), a persisted
                # volume. Single-user-per-container, so no cross-user risk.
                "PIP_USER": "1",
                "PIP_BREAK_SYSTEM_PACKAGES": "1",
                "PYTHONPATH": settings.dedicated_hermes_user_site_path,
            }
        )
    if sso_token:
        env["INFOX_MED_TOKEN"] = sso_token
    return env


def _container_config(container: docker.models.containers.Container) -> dict:
    config = container.attrs.get("Config", {}) or {}
    return config if isinstance(config, dict) else {}


def _container_matches_runtime(container: docker.models.containers.Container) -> bool:
    """Return whether an existing user container matches the configured runtime backend."""
    config = _container_config(container)
    env = set(config.get("Env") or [])
    entrypoint = " ".join(str(part) for part in (config.get("Entrypoint") or []))
    command = " ".join(str(part) for part in (config.get("Cmd") or []))

    if _runtime_backend() == "hermes":
        return (
            "API_SERVER_ENABLED=true" in env
            and (
                "/opt/hermes/docker/entrypoint.sh" in entrypoint
                or "/opt/hermes/docker/main-wrapper.sh" in entrypoint
            )
            and "gateway" in command
        )

    return "BRIDGE_ENABLE_CHANNELS=1" in env and "bridge/dist/bridge/start.js" in command


def _runtime_published_ports() -> dict[str, tuple[str, int | None]]:
    if _runtime_backend() == "hermes":
        return {
            f"{_internal_port()}/tcp": (settings.user_container_bind_ip, None),
        }
    return {
        "5900/tcp": (settings.user_container_bind_ip, None),
        "30000/tcp": (settings.user_container_bind_ip, None),
    }


def _runtime_preferred_ports(browser_port: int | None, service_port: int | None) -> dict[str, tuple[str, int | None]] | None:
    if _runtime_backend() == "hermes":
        return None
    if browser_port is None or service_port is None or browser_port == service_port:
        return None
    return {
        "5900/tcp": (settings.user_container_bind_ip, browser_port),
        "30000/tcp": (settings.user_container_bind_ip, service_port),
    }


def _published_port_bindings(container: docker.models.containers.Container) -> tuple[tuple[str, str], tuple[str, str]]:
    if _runtime_backend() == "hermes":
        return ("", ""), _published_binding(container, f"{_internal_port()}/tcp")
    return _published_binding(container, "5900/tcp"), _published_binding(container, "30000/tcp")


def _build_runtime_metadata_markdown(user_id: str, container_name: str, runtime_backend: str) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime())
    payload = {
        "user_id": user_id,
        "container": container_name,
        "runtime_backend": runtime_backend,
        "generated_at": now,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


def _build_hermes_config_yaml() -> str:
    config = {
        "model": {
            "default": settings.default_model,
            "provider": settings.dedicated_hermes_default_provider,
            "base_url": settings.dedicated_hermes_default_base_url,
        },
        "platform_toolsets": {
            "api_server": _hermes_api_toolsets(),
        },
        "agent": {
            "reasoning_effort": settings.hermes_reasoning_effort,
            "service_tier": settings.hermes_service_tier,
        },
    }
    return yaml.safe_dump(config, allow_unicode=True, sort_keys=False)


def _hermes_api_toolsets() -> list[str]:
    raw = (settings.hermes_api_toolsets or "").strip()
    if not raw or raw.lower() in {"none", "off", "false", "0"}:
        return []
    if raw.lower() in {"full", "default", "hermes-api-server"}:
        return ["hermes-api-server"]
    return [part.strip() for part in raw.replace(";", ",").split(",") if part.strip()]


def _build_hermes_env_file(preserve_vars: dict | None = None) -> str:
    lines = [
        f"API_SERVER_KEY={settings.dedicated_hermes_api_key}",
        "GATEWAY_ALLOW_ALL_USERS=true",
        f"HERMES_API_TOOLSETS={settings.hermes_api_toolsets}",
        f"HERMES_REASONING_EFFORT={settings.hermes_reasoning_effort}",
        f"HERMES_SERVICE_TIER={settings.hermes_service_tier}",
    ]
    default_api_key = (settings.dedicated_hermes_default_api_key or "").strip()
    if default_api_key:
        lines.append(f"OPENAI_API_KEY={default_api_key}")
    # Preserve messaging-channel vars (FEISHU_*, TELEGRAM_*, ...) configured via
    # the web onboarding flow / `hermes gateway setup`, so rebuilding the user
    # container does not wipe channel credentials.
    for key, value in (preserve_vars or {}).items():
        lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


def _platform_proxy_model_ref(model: str) -> str:
    model = (model or "").strip()
    if not model:
        return ""
    if model.startswith("platform-proxy/"):
        return model
    return f"platform-proxy/{model}"


def _apply_openclaw_model_config(config: dict, default_model: str) -> bool:
    target_model = _platform_proxy_model_ref(default_model)
    if not target_model:
        return False

    agents = config.setdefault("agents", {})
    defaults = agents.setdefault("defaults", {})
    changed = False
    if defaults.get("model") != target_model:
        defaults["model"] = target_model
        changed = True

    agent_list = agents.get("list")
    if not isinstance(agent_list, list):
        agent_list = []
        agents["list"] = agent_list

    main_agent = None
    for agent in agent_list:
        if isinstance(agent, dict) and str(agent.get("id") or "").lower() == "main":
            main_agent = agent
            break

    if main_agent is None:
        agent_list.insert(0, {"id": "main", "default": True, "model": target_model})
        changed = True
    elif main_agent.get("model") != target_model:
        main_agent["model"] = target_model
        changed = True

    return changed


def _write_openclaw_model_config(container: docker.models.containers.Container) -> None:
    target_model = _platform_proxy_model_ref(settings.default_model)
    if not target_model:
        return
    script = r"""
import json
import sys
import time
from pathlib import Path

target_model = sys.argv[1]
config_path = Path("/root/.openclaw/openclaw.json")
last_text = None
stable_reads = 0
for _ in range(40):
    if config_path.exists():
        try:
            current_text = config_path.read_text(encoding="utf-8")
        except OSError:
            current_text = None
        if current_text is not None:
            if current_text == last_text:
                stable_reads += 1
            else:
                last_text = current_text
                stable_reads = 1
            if stable_reads >= 4:
                break
    time.sleep(0.5)

if config_path.exists():
    config = json.loads(config_path.read_text(encoding="utf-8"))
else:
    config = {}

agents = config.setdefault("agents", {})
defaults = agents.setdefault("defaults", {})
defaults["model"] = target_model
agent_list = agents.setdefault("list", [])
main_agent = None
for agent in agent_list:
    if isinstance(agent, dict) and str(agent.get("id") or "").lower() == "main":
        main_agent = agent
        break
if main_agent is None:
    agent_list.insert(0, {"id": "main", "default": True, "model": target_model})
else:
    main_agent["model"] = target_model
config_path.parent.mkdir(parents=True, exist_ok=True)
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
"""
    result = container.exec_run(["python3", "-c", script, target_model])
    if result.exit_code != 0:
        output = result.output.decode("utf-8", errors="replace") if result.output else ""
        raise RuntimeError(f"failed to patch OpenClaw model config: {output}")


def _write_runtime_metadata(container: docker.models.containers.Container, markdown: str) -> None:
    content = markdown.encode("utf-8")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
        workspace_dir = tarfile.TarInfo(name="workspace")
        workspace_dir.type = tarfile.DIRTYPE
        workspace_dir.mode = 0o755
        workspace_dir.mtime = int(time.time())
        tar.addfile(workspace_dir)

        metadata_file = tarfile.TarInfo(name="workspace/platform-runtime.json")
        metadata_file.size = len(content)
        metadata_file.mode = 0o644
        metadata_file.mtime = int(time.time())
        tar.addfile(metadata_file, io.BytesIO(content))

    tar_buffer.seek(0)
    ok = container.put_archive("/", tar_buffer.read())
    if not ok:
        raise RuntimeError("failed to write platform-runtime.json into container workspace")


def _repair_hermes_data_ownership(container: docker.models.containers.Container) -> None:
    """Make files injected into the Hermes data volume writable by the hermes user."""
    data_volume = ""
    for mount in container.attrs.get("Mounts", []) or []:
        if mount.get("Destination") == "/opt/data" and mount.get("Type") == "volume":
            data_volume = str(mount.get("Name") or "").strip()
            break

    if data_volume:
        _docker().containers.run(
            image=_runtime_image(),
            entrypoint="chown",
            command=["-R", "hermes:hermes", "/opt/data"],
            mounts=[docker.types.Mount("/opt/data", data_volume, type="volume")],
            remove=True,
        )
        return

    result = container.exec_run(["chown", "-R", "hermes:hermes", "/opt/data"], user="root")
    exit_code = getattr(result, "exit_code", result[0] if isinstance(result, tuple) else 0)
    if exit_code != 0:
        output = getattr(result, "output", result[1] if isinstance(result, tuple) and len(result) > 1 else b"")
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        raise RuntimeError(f"failed to repair Hermes data ownership: {output}")


def _read_existing_hermes_config(container: docker.models.containers.Container) -> dict:
    """Read existing config.yaml from container, return {} if not found."""
    try:
        result = container.exec_run(["cat", "/opt/data/config.yaml"], user="root")
        if result.exit_code == 0 and result.output:
            return yaml.safe_load(result.output.decode("utf-8")) or {}
    except Exception:
        pass
    return {}


# Messaging-channel env prefixes managed by the web onboarding flow / hermes
# gateway setup (not by the platform). These must survive container rebuilds or
# channel credentials configured by the user are lost.
_CHANNEL_ENV_PREFIXES = (
    "FEISHU_", "LARK_", "TELEGRAM_", "DISCORD_", "SLACK_", "WHATSAPP_",
    "MATRIX_", "MATTERMOST_", "WEIXIN_", "WECOM_", "DINGTALK_", "SIGNAL_",
    "IRC_", "NOSTR_", "TWITCH_", "ZALO_", "QQBOT_", "GOOGLECHAT_", "MSTEAMS_",
)


def _read_existing_hermes_env_channel_vars(container: docker.models.containers.Container) -> dict:
    """Read channel-related env vars from existing /opt/data/.env so they survive a rebuild."""
    try:
        result = container.exec_run(["cat", "/opt/data/.env"], user="root")
    except Exception:
        return {}
    if getattr(result, "exit_code", 1) != 0 or not result.output:
        return {}
    preserved: dict = {}
    for raw_line in result.output.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith(_CHANNEL_ENV_PREFIXES):
            preserved[key] = value.strip()
    return preserved


def _write_hermes_runtime_files(container: docker.models.containers.Container) -> None:
    platform_config = yaml.safe_load(_build_hermes_config_yaml()) or {}
    existing_config = _read_existing_hermes_config(container)

    if existing_config.get("custom_providers"):
        user_providers = [
            p for p in existing_config["custom_providers"]
            if isinstance(p, dict) and p.get("name") not in ("platform-gateway", "platform")
        ]
        if user_providers:
            gateway = [
                p for p in platform_config.get("custom_providers", [])
                if isinstance(p, dict) and p.get("name") == "platform-gateway"
            ]
            platform_config["custom_providers"] = gateway + user_providers
    if (existing_config.get("model") or {}).get("default"):
        platform_config.setdefault("model", {})["default"] = existing_config["model"]["default"]
    # Preserve user's model.provider (e.g. "deepseek") so user-added
    # custom_providers with their own API keys are routed directly rather
    # than being forced through platform-gateway on container restart.
    existing_provider = (existing_config.get("model") or {}).get("provider", "")
    if existing_provider and existing_provider != "platform-gateway":
        platform_config.setdefault("model", {})["provider"] = existing_provider
        platform_config["model"].pop("base_url", None)

    config_content = yaml.safe_dump(platform_config, allow_unicode=True, sort_keys=False).encode("utf-8")
    env_content = _build_hermes_env_file(
        _read_existing_hermes_env_channel_vars(container)
    ).encode("utf-8")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
        config_file = tarfile.TarInfo(name="config.yaml")
        config_file.size = len(config_content)
        config_file.mode = 0o644
        config_file.mtime = int(time.time())
        tar.addfile(config_file, io.BytesIO(config_content))

        env_file = tarfile.TarInfo(name=".env")
        env_file.size = len(env_content)
        env_file.mode = 0o600
        env_file.mtime = int(time.time())
        tar.addfile(env_file, io.BytesIO(env_content))

    tar_buffer.seek(0)
    ok = container.put_archive("/opt/data", tar_buffer.read())
    if not ok:
        raise RuntimeError("failed to write Hermes config.yaml/.env into container data volume")
    _repair_hermes_data_ownership(container)


def _build_expose_port_skill_markdown(
    user_id: str,
    container_name: str,
    browser_binding: tuple[str, str],
    service_binding: tuple[str, str],
    public_base_url: str = "",
) -> str:
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime())
    lines = [
        "---",
        "name: container-expose-info",
        "description: Current container info and host-exposed ports (5900/30000).",
        "---",
        "",
        "# Container Expose Info",
        "",
        f"- User ID: `{user_id}`",
        f"- Container: `{container_name}`",
        f"- Generated At: `{now}`",
        "",
        "## Mapped Ports",
        "",
    ]

    browser_ip, browser_port = browser_binding
    service_ip, service_port = service_binding

    if browser_port:
        lines.append(f"- `5900/tcp` (browser) -> `{browser_ip}:{browser_port}`")
    else:
        lines.append("- `5900/tcp` (browser) -> `not published`")

    if service_port:
        lines.append(f"- `30000/tcp` (service) -> `{service_ip}:{service_port}`")
    else:
        lines.append("- `30000/tcp` (service) -> `not published`")

    # External access URLs (for users accessing from outside the server)
    if public_base_url:
        base = public_base_url.rstrip("/")
        # Extract domain from URL (e.g. "https://openclaw.infox-med.com" -> "openclaw.infox-med.com")
        from urllib.parse import urlparse
        parsed = urlparse(base)
        domain = parsed.hostname or ""
        scheme = parsed.scheme or "https"

        lines.extend(["", "## External Access URLs", ""])
        if service_port:
            lines.append(f"- Service URL: `{scheme}://{domain}:{service_port}`")
        if browser_port:
            lines.append(f"- Browser URL: `{scheme}://{domain}:{browser_port}`")
        lines.extend([
            "",
            "**Important**: When the user creates a web service on port 30000 inside the container,",
            f"tell them to access it via the Service URL above (`{scheme}://{domain}:{service_port}`).",
            "Do NOT use `0.0.0.0` or `localhost` — those are internal addresses not reachable from outside.",
        ])

    lines.extend([
        "",
        "## Notes",
        "",
        "- This file is auto-generated during user container creation.",
        "- Recreate the user container to refresh mapped host ports.",
        "",
    ])
    return "\n".join(lines)


def _write_expose_port_skill(container: docker.models.containers.Container, markdown: str) -> None:
    """Write /root/.openclaw/workspace/skills/container-expose-info/SKILL.md via put_archive."""
    content = markdown.encode("utf-8")
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w") as tar:
        workspace_dir = tarfile.TarInfo(name="workspace")
        workspace_dir.type = tarfile.DIRTYPE
        workspace_dir.mode = 0o755
        workspace_dir.mtime = int(time.time())
        tar.addfile(workspace_dir)

        skills_dir = tarfile.TarInfo(name="workspace/skills")
        skills_dir.type = tarfile.DIRTYPE
        skills_dir.mode = 0o755
        skills_dir.mtime = int(time.time())
        tar.addfile(skills_dir)

        skill_subdir = tarfile.TarInfo(name="workspace/skills/container-expose-info")
        skill_subdir.type = tarfile.DIRTYPE
        skill_subdir.mode = 0o755
        skill_subdir.mtime = int(time.time())
        tar.addfile(skill_subdir)

        skill_file = tarfile.TarInfo(name="workspace/skills/container-expose-info/SKILL.md")
        skill_file.size = len(content)
        skill_file.mode = 0o644
        skill_file.mtime = int(time.time())
        tar.addfile(skill_file, io.BytesIO(content))

    tar_buffer.seek(0)
    ok = container.put_archive("/root/.openclaw", tar_buffer.read())
    if not ok:
        raise RuntimeError("failed to write container-expose-info SKILL.md into container")


async def get_container(db: AsyncSession, user_id: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.user_id == user_id))
    return result.scalar_one_or_none()


async def get_container_by_token(db: AsyncSession, token: str) -> Container | None:
    result = await db.execute(select(Container).where(Container.container_token == token))
    return result.scalar_one_or_none()


async def get_user_port_binding(db: AsyncSession, user_id: str) -> UserPortBinding | None:
    result = await db.execute(select(UserPortBinding).where(UserPortBinding.user_id == user_id))
    return result.scalar_one_or_none()


async def upsert_user_port_binding(
    db: AsyncSession,
    user_id: str,
    host_bind_ip: str,
    host_port_browser: int | None,
    host_port_service: int | None,
) -> None:
    stmt = (
        pg_insert(UserPortBinding)
        .values(
            user_id=user_id,
            host_bind_ip=host_bind_ip,
            host_port_browser=host_port_browser,
            host_port_service=host_port_service,
        )
        .on_conflict_do_update(
            index_elements=[UserPortBinding.__table__.c.user_id],
            set_={
                "host_bind_ip": host_bind_ip,
                "host_port_browser": host_port_browser,
                "host_port_service": host_port_service,
            },
        )
    )
    await db.execute(stmt)


async def create_container(db: AsyncSession, user_id: str) -> Container | None:
    """Create a Docker container for a user and record metadata in DB.

    Inserts a DB record first to claim the user_id slot (preventing races),
    then creates the Docker container and updates the record.
    Returns None if another request already claimed the slot.
    """
    container_token = secrets.token_urlsafe(32)
    short_id = user_id[:8]
    runtime_backend = _runtime_backend()

    # Insert DB record to claim the unique user_id slot.
    # ON CONFLICT DO NOTHING avoids PostgreSQL ERROR logs on races.
    stmt = (
        pg_insert(Container)
        .values(
            user_id=user_id,
            docker_id="",
            container_token=container_token,
            status="creating",
            internal_host="",
            internal_port=_internal_port(),
        )
        .on_conflict_do_nothing(index_elements=["user_id"])
        .returning(Container.__table__.c.id)
    )
    result = await db.execute(stmt)
    row = result.first()
    if row is None:
        # Another request already claimed this user_id — not an error
        return None

    await db.flush()
    record = await get_container(db, user_id)

    # Now safe to create Docker resources — we hold the DB slot.
    _ensure_network()
    client = _docker()

    data_vol = _data_volume_name(short_id)
    container_name = _container_name(short_id)

    # Remove any stale container with the same name
    try:
        stale = client.containers.get(container_name)
        stale.remove(force=True)
    except DockerNotFound:
        pass

    # Fetch user's SSO token if available (e.g. InfoX-Med)
    user_result = await db.execute(select(User).where(User.id == user_id))
    user_row = user_result.scalar_one_or_none()
    sso_token = user_row.sso_token if user_row else None

    container_env = _runtime_environment(container_token, sso_token)

    run_kwargs = {
        "image": _runtime_image(),
        "command": _runtime_command(),
        "name": container_name,
        "detach": True,
        "environment": container_env,
        "mounts": _build_runtime_mounts(data_vol, short_id),
        "network": settings.container_network,
        "mem_limit": settings.container_memory_limit,
        "shm_size": settings.container_shm_size,
        "nano_cpus": int(settings.container_cpu_limit * 1e9),
        "pids_limit": settings.container_pids_limit,
        "restart_policy": {"Name": "unless-stopped"},
    }

    if settings.user_container_publish_ports:
        binding = await get_user_port_binding(db, user_id)
        preferred_browser_port = binding.host_port_browser if binding is not None else None
        preferred_service_port = binding.host_port_service if binding is not None else None

        preferred_ports = _runtime_preferred_ports(preferred_browser_port, preferred_service_port)
        preferred_usable = preferred_ports is not None and all(
            not _is_host_port_in_use(client, host_port)
            for _container_port, (_host_ip, host_port) in preferred_ports.items()
            if host_port is not None
        )

        run_kwargs["ports"] = preferred_ports if preferred_usable else _runtime_published_ports()

    try:
        docker_container = client.containers.run(**run_kwargs)
    except DockerAPIError as exc:
        # Preferred ports can race with other creators; fallback to random publish.
        if settings.user_container_publish_ports and "port is already allocated" in str(exc).lower():
            run_kwargs["ports"] = _runtime_published_ports()
            docker_container = client.containers.run(**run_kwargs)
        else:
            await db.rollback()
            raise
    except Exception:
        # Docker creation failed — remove the placeholder DB record
        await db.rollback()
        raise

    # Read container IP on the internal network
    docker_container.reload()
    browser_binding, service_binding = _published_port_bindings(docker_container)
    if runtime_backend == "openclaw":
        _write_openclaw_model_config(docker_container)
        expose_markdown = _build_expose_port_skill_markdown(
            user_id=user_id,
            container_name=container_name,
            browser_binding=browser_binding,
            service_binding=service_binding,
            public_base_url=settings.public_base_url,
        )
        _write_expose_port_skill(docker_container, expose_markdown)
    else:
        runtime_metadata = _build_runtime_metadata_markdown(
            user_id=user_id,
            container_name=container_name,
            runtime_backend=runtime_backend,
        )
        _write_runtime_metadata(docker_container, runtime_metadata)
        _write_hermes_runtime_files(docker_container)

    network_settings = docker_container.attrs["NetworkSettings"]["Networks"]
    internal_ip = network_settings.get(settings.container_network, {}).get("IPAddress", "")

    record.docker_id = docker_container.id
    record.status = "running"
    record.internal_host = internal_ip
    await upsert_user_port_binding(
        db=db,
        user_id=user_id,
        host_bind_ip=browser_binding[0] or service_binding[0] or settings.user_container_bind_ip,
        host_port_browser=int(browser_binding[1]) if browser_binding[1] else None,
        host_port_service=int(service_binding[1]) if service_binding[1] else None,
    )
    await db.commit()
    await db.refresh(record)
    return record


async def ensure_running(db: AsyncSession, user_id: str) -> Container:
    """Return a running container for the user, creating or unpausing as needed."""
    import asyncio

    record = await get_container(db, user_id)

    if record is None:
        created = await create_container(db, user_id)
        if created is not None:
            return created
        # Race condition: another request created the container first
        record = await get_container(db, user_id)
        if record is None:
            raise RuntimeError("Failed to create or find container")

    # Another request is still creating the container — wait for it
    if record.status == "creating":
        for _ in range(30):  # wait up to 60s
            await asyncio.sleep(2)
            await db.expire(record)
            record = await get_container(db, user_id)
            if record is None or record.status != "creating":
                break
        if record is None:
            return await create_container(db, user_id)
        if record.status == "creating":
            raise RuntimeError("Container creation timed out")

    client = _docker()

    async def recreate_record(record: Container, docker_container=None) -> Container:
        if docker_container is not None:
            try:
                docker_container.remove(force=True)
            except DockerNotFound:
                pass
        await db.delete(record)
        await db.commit()
        created = await create_container(db, user_id)
        if created is not None:
            return created
        found = await get_container(db, user_id)
        if found is not None:
            return found
        raise RuntimeError("Failed to recreate container")

    if record.status == "paused":
        try:
            c = client.containers.get(record.docker_id)
            if not _container_matches_runtime(c):
                return await recreate_record(record, c)
            c.unpause()
            await db.execute(
                update(Container)
                .where(Container.id == record.id)
                .values(status="running")
            )
            await db.commit()
            record.status = "running"
        except DockerNotFound:
            # Container was removed externally — recreate
            return await recreate_record(record)

    elif record.status == "stopped":
        try:
            c = client.containers.get(record.docker_id)
            if not _container_matches_runtime(c):
                return await recreate_record(record, c)
            c.start()
            c.reload()
            # Sync internal IP after start
            nets = c.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_info in nets.values():
                current_ip = net_info.get("IPAddress", "")
                if current_ip:
                    record.internal_host = current_ip
                    break
            await db.execute(
                update(Container)
                .where(Container.id == record.id)
                .values(status="running", internal_host=record.internal_host)
            )
            await db.commit()
            record.status = "running"
        except DockerNotFound:
            # Container was removed externally — recreate
            return await recreate_record(record)

    elif record.status == "archived":
        # Recreate from persisted data volumes
        return await recreate_record(record)

    elif record.status == "running":
        # Verify it's actually running
        try:
            c = client.containers.get(record.docker_id)
            if not _container_matches_runtime(c):
                return await recreate_record(record, c)
            if c.status != "running":
                c.start()
                c.reload()
            # Sync internal IP — it may change after container restart
            nets = c.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_info in nets.values():
                current_ip = net_info.get("IPAddress", "")
                if current_ip and current_ip != record.internal_host:
                    record.internal_host = current_ip
                    await db.execute(
                        update(Container)
                        .where(Container.id == record.id)
                        .values(internal_host=current_ip)
                    )
                    await db.commit()
                break
        except DockerNotFound:
            return await recreate_record(record)

    return record


async def pause_container(db: AsyncSession, user_id: str) -> bool:
    """Pause a user's container to save resources."""
    record = await get_container(db, user_id)
    if record is None or record.status != "running":
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.pause()
        await db.execute(
            update(Container).where(Container.id == record.id).values(status="paused")
        )
        await db.commit()
        return True
    except DockerNotFound:
        return False


async def resume_container(db: AsyncSession, user_id: str) -> bool:
    """Resume a paused or stopped container to running state."""
    record = await get_container(db, user_id)
    if record is None:
        return False

    if record.status == "running":
        return True  # Already running

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)

        if record.status == "paused":
            c.unpause()
        elif record.status == "stopped":
            c.start()

        # Reload to get latest status
        c.reload()
        await db.execute(
            update(Container).where(Container.id == record.id).values(status="running")
        )
        await db.commit()
        return True
    except DockerNotFound:
        return False


async def destroy_container(db: AsyncSession, user_id: str) -> bool:
    """Stop and remove a user's container (data volumes are preserved)."""
    record = await get_container(db, user_id)
    if record is None:
        return False

    client = _docker()
    try:
        c = client.containers.get(record.docker_id)
        c.stop(timeout=10)
        c.remove()
    except DockerNotFound:
        pass

    await db.delete(record)
    await db.commit()
    return True
