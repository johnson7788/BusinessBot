"""Docker container lifecycle management for per-user openclaw instances."""

from __future__ import annotations

import io
import secrets
import tarfile
import time
from pathlib import Path

import docker
from docker.errors import APIError as DockerAPIError, NotFound as DockerNotFound
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


def _expected_container_name(user_id: str) -> str:
    return f"openclaw-user-{user_id[:8]}"


async def _recreate_container_record(db: AsyncSession, record: Container, existing_container=None) -> Container:
    """Drop a stale DB binding and recreate the user's OpenClaw container."""
    if existing_container is not None:
        try:
            existing_container.remove(force=True)
        except DockerNotFound:
            pass

    user_id = record.user_id
    await db.delete(record)
    await db.commit()
    created = await create_container(db, user_id)
    if created is not None:
        return created
    record = await get_container(db, user_id)
    if record is not None:
        return record
    raise RuntimeError("Failed to recreate container")


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
            internal_port=18080,
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

    data_vol = f"openclaw-data-{short_id}"
    container_name = f"openclaw-user-{short_id}"

    # Remove any stale container with the same name
    try:
        stale = client.containers.get(container_name)
        stale.remove(force=True)
    except DockerNotFound:
        pass

    # Fetch user's SSO token if available (e.g. InfoX-Med)
    # user_result = await db.execute(select(User).where(User.id == user_id))
    # user_row = user_result.scalar_one_or_none()
    # sso_token = user_row.sso_token if user_row else None

    container_env = {
        "NANOBOT_PROXY__URL": f"http://gateway:8080/llm/v1",
        "NANOBOT_PROXY__TOKEN": container_token,
        "NANOBOT_AGENTS__DEFAULTS__MODEL": settings.default_model,
        "DEPLOY_VERSION": settings.deploy_version,
        "TZ": settings.container_tz,
        "BRIDGE_ENABLE_CHANNELS": "1",
    }
    # if sso_token:
    #     container_env["SSO_TOKEN"] = sso_token

    run_kwargs = {
        "image": settings.openclaw_image,
        "command": ["node", "bridge/dist/bridge/start.js"],
        "name": container_name,
        "detach": True,
        "environment": container_env,
        "mounts": [
            docker.types.Mount("/root/.openclaw", data_vol, type="volume"),
        ],
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

        preferred_usable = (
            preferred_browser_port is not None
            and preferred_service_port is not None
            and preferred_browser_port != preferred_service_port
            and not _is_host_port_in_use(client, preferred_browser_port)
            and not _is_host_port_in_use(client, preferred_service_port)
        )

        if preferred_usable:
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, preferred_browser_port),
                "30000/tcp": (settings.user_container_bind_ip, preferred_service_port),
            }
        else:
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, None),
                "30000/tcp": (settings.user_container_bind_ip, None),
            }

    try:
        docker_container = client.containers.run(**run_kwargs)
    except DockerAPIError as exc:
        # Preferred ports can race with other creators; fallback to random publish.
        if settings.user_container_publish_ports and "port is already allocated" in str(exc).lower():
            run_kwargs["ports"] = {
                "5900/tcp": (settings.user_container_bind_ip, None),
                "30000/tcp": (settings.user_container_bind_ip, None),
            }
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
    browser_binding = _published_binding(docker_container, "5900/tcp")
    service_binding = _published_binding(docker_container, "30000/tcp")
    expose_markdown = _build_expose_port_skill_markdown(
        user_id=user_id,
        container_name=container_name,
        browser_binding=browser_binding,
        service_binding=service_binding,
        public_base_url=settings.public_base_url,
    )
    _write_expose_port_skill(docker_container, expose_markdown)

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

    if record.docker_id:
        try:
            c = client.containers.get(record.docker_id)
            if c.name != _expected_container_name(user_id):
                return await _recreate_container_record(db, record, c)
        except DockerNotFound:
            await db.delete(record)
            await db.commit()
            created = await create_container(db, user_id)
            if created is not None:
                return created
            record = await get_container(db, user_id)
            if record is not None:
                return record
            raise RuntimeError("Failed to recreate container")

    if record.status == "paused":
        try:
            c = client.containers.get(record.docker_id)
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
            return await _recreate_container_record(db, record)

    elif record.status == "archived":
        # Recreate from persisted data volumes
        return await _recreate_container_record(db, record)

    elif record.status == "running":
        # Verify it's actually running
        try:
            c = client.containers.get(record.docker_id)
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
            return await _recreate_container_record(db, record)

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
