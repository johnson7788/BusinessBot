#!/usr/bin/env python3
"""OpenClaw 本地开发启动脚本（跨平台：macOS / Linux / Windows）。

一键启动所有本地开发服务：
  1. PostgreSQL (Docker 容器, 端口 5432)
  2. openclaw bridge 后端 (端口 18080)
  3. platform gateway (端口 8080)
  4. frontend dev server (端口 3080)

用法:
  # 启动所有服务（默认局域网可访问）
  python start_local.py

  # 仅启动部分服务
  python start_local.py --only db,gateway,frontend

  # 跳过某些服务
  python start_local.py --skip bridge

  # 停止所有服务
  python start_local.py --stop

  # 强制仅本机访问
  python start_local.py --local-only

  # 手动指定 API 地址（如远程服务器）
  python start_local.py --api-url http://192.168.1.100:8080
"""

import argparse
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time

# ── 平台检测 ─────────────────────────────────────────────────────────
IS_WINDOWS = sys.platform == "win32"

# ── 颜色输出 ──────────────────────────────────────────────────────────
GREEN = "\033[32m"
RED   = "\033[31m"
YELLOW = "\033[33m"
CYAN  = "\033[36m"
BOLD  = "\033[1m"
DIM   = "\033[2m"
RESET = "\033[0m"

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

# ── 服务配置 ──────────────────────────────────────────────────────────
SERVICES = {
    "db": {
        "name": "PostgreSQL",
        "port": 5432,
        "color": "\033[34m",
    },
    "bridge": {
        "name": "OpenClaw Bridge",
        "port": 18080,
        "color": "\033[35m",
    },
    "gateway": {
        "name": "Platform Gateway",
        "port": 8080,
        "color": "\033[36m",  # cyan
    },
    "frontend": {
        "name": "Frontend Dev",
        "port": 3080,
        "color": "\033[33m",  # yellow
    },
    "manage": {
        "name": "Manage Admin",
        "port": 3081,
        "color": "\033[32m",  # green
    },
    "simple": {
        "name": "Simple Front",
        "port": 3085,
        "color": "\033[95m",  # light magenta
    },
}


# ── 工具函数 ──────────────────────────────────────────────────────────

def log(msg: str, color: str = CYAN):
    print(f"{color}{BOLD}▸{RESET} {msg}")


def success(msg: str):
    print(f"{GREEN}✓{RESET} {msg}")


def error(msg: str):
    print(f"{RED}✗{RESET} {msg}")


def warn(msg: str):
    print(f"{YELLOW}⚠{RESET} {msg}")


def is_port_in_use(port: int) -> bool:
    """检查端口是否被占用。"""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def wait_for_port(port: int, timeout: int = 30, name: str = "") -> bool:
    """等待端口可用。"""
    for i in range(timeout):
        if is_port_in_use(port):
            return True
        time.sleep(1)
        sys.stdout.write(f"\r  等待 {name or f'端口 {port}'}... ({i + 1}/{timeout}s)")
        sys.stdout.flush()
    print()
    return False


def _base_env(**extra) -> dict:
    """构建子进程环境变量，Windows 上额外注入 PYTHONIOENCODING=utf-8。"""
    env = {**os.environ}
    if IS_WINDOWS:
        env["PYTHONIOENCODING"] = "utf-8"
    env.update(extra)
    return env


def _detect_lan_ip() -> str:
    """尽力探测当前机器的局域网 IP（失败时回退 127.0.0.1）。

    跳过 VPN/代理隧道接口（utun 等）返回的 IP，这些 IP 虽然是出口地址，
    但其他局域网设备无法直接连接。
    """
    # 已知的 VPN/隧道 IP 段（198.18.0.0/15 是 Surge/ClashX 等代理工具常用的）
    _TUNNEL_PREFIXES = ("198.18.", "198.19.", "100.64.")

    # 方式1：先尝试 UDP 探测，但要过滤隧道 IP
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not any(ip.startswith(p) for p in _TUNNEL_PREFIXES):
                return ip
    except OSError:
        pass

    # 方式2：遍历网卡，找到真实的局域网 IP（macOS / Linux）
    try:
        import subprocess as _sp
        result = _sp.run(["ifconfig"], capture_output=True, text=True, timeout=5)
        if result.returncode == 0:
            import re
            for match in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)", result.stdout):
                addr = match.group(1)
                if (addr.startswith(("192.168.", "10.", "172."))
                        and not any(addr.startswith(p) for p in _TUNNEL_PREFIXES)):
                    return addr
    except Exception:
        pass

    return "127.0.0.1"


# ── PostgreSQL ────────────────────────────────────────────────────────

def start_postgres() -> bool:
    """启动 PostgreSQL Docker 容器。"""
    log("启动 PostgreSQL...")

    # 检查是否已有容器在运行
    result = subprocess.run(
        ["docker", "ps", "-q", "--filter", "name=^openclaw-local-postgres$"],
        capture_output=True, text=True,
    )
    if result.stdout.strip():
        success("PostgreSQL 已在运行")
        return True

    # 检查是否有已停止的容器
    result = subprocess.run(
        ["docker", "ps", "-aq", "--filter", "name=^openclaw-local-postgres$"],
        capture_output=True, text=True,
    )
    if result.stdout.strip():
        log("启动已有的 PostgreSQL 容器...")
        subprocess.run(["docker", "start", "openclaw-local-postgres"], check=True)
    else:
        log("创建新的 PostgreSQL 容器...")
        subprocess.run([
            "docker", "run", "-d",
            "--name", "openclaw-local-postgres",
            "-e", "POSTGRES_USER=nanobot",
            "-e", "POSTGRES_PASSWORD=nanobot",
            "-e", "POSTGRES_DB=nanobot_platform",
            "-v", "openclaw-local-pgdata:/var/lib/postgresql/data",
            "-p", "5432:5432",
            "postgres:16-alpine",
        ], check=True)

    if wait_for_port(5432, timeout=15, name="PostgreSQL"):
        # 端口已就绪，再验证数据库连接
        for attempt in range(1, 11):
            try:
                result = subprocess.run(
                    ["docker", "exec", "openclaw-local-postgres", "psql", "-U", "nanobot", "-d", "postgres", "-c", "SELECT 1"],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    success("PostgreSQL 就绪 (端口 5432)")
                    return True
            except subprocess.TimeoutExpired:
                pass
            except Exception:
                pass
            sys.stdout.write(f"\r  验证数据库连接... ({attempt}/10s)")
            sys.stdout.flush()
            time.sleep(1)
        print()
        error("PostgreSQL 连接验证失败")
        return False
    else:
        error("PostgreSQL 启动超时")
        return False


def stop_postgres():
    """停止 PostgreSQL 容器。"""
    subprocess.run(["docker", "stop", "openclaw-local-postgres"], capture_output=True)
    success("PostgreSQL 已停止")


# ── OpenClaw Bridge ───────────────────────────────────────────────────

def start_bridge(env: dict) -> "subprocess.Popen | None":
    log("启动 OpenClaw Bridge 后端 (端口 18080)...")

    if is_port_in_use(18080):
        warn("端口 18080 已被占用，跳过 bridge")
        return None

    bridge_dir = os.path.join(PROJECT_DIR, "openclaw")

    # 优先使用 tsx 开发模式，否则使用编译后的 JS
    tsx_path = shutil.which("tsx")
    if tsx_path:
        cmd = [tsx_path, "bridge/start.ts"]
    else:
        npx_path = shutil.which("npx")
        if npx_path:
            cmd = [npx_path, "tsx", "bridge/start.ts"]
        else:
            cmd = ["node", "bridge/dist/bridge/start.js"]

    # 本地开发模式：启用渠道（飞书、Telegram 等），不跳过
    bridge_env = _base_env(BRIDGE_ENABLE_CHANNELS="1", **env)

    proc = subprocess.Popen(
        cmd,
        cwd=bridge_dir,
        env=bridge_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    log(f"  PID: {proc.pid}")

    # 等待就绪，同时实时显示 bridge 输出以便诊断问题
    timeout = 120
    output_lines: list[str] = []
    bridge_color = SERVICES["bridge"]["color"]

    for elapsed in range(1, timeout + 1):
        # 读取所有可用的输出（非阻塞）
        _drain_output(proc, output_lines, bridge_color)

        # 检查进程是否已退出
        if proc.poll() is not None:
            # 进程已退出，读取剩余输出
            _drain_output(proc, output_lines, bridge_color)
            exit_code = proc.returncode
            error(f"OpenClaw Bridge 启动失败 (exit code: {exit_code})")
            if output_lines:
                # 显示最后几行错误信息
                print()
                last_lines = output_lines[-15:]
                for line in last_lines:
                    print(f"  {RED}│{RESET} {line}")
                print()
            _suggest_bridge_fix(output_lines)
            return None

        if is_port_in_use(18080):
            success("OpenClaw Bridge 就绪 (端口 18080)")
            return proc

        # 进度提示
        if elapsed % 10 == 0:
            if elapsed <= 30:
                hint = "正在启动..."
            elif elapsed <= 60:
                hint = "首次启动需要编译 openclaw..."
            else:
                hint = "编译时间较长，请耐心等待..."
            sys.stdout.write(f"\r  等待 OpenClaw Bridge... ({elapsed}/{timeout}s) {DIM}{hint}{RESET}  ")
            sys.stdout.flush()

    print()
    # 超时
    _drain_output(proc, output_lines, bridge_color)
    warn("OpenClaw Bridge 启动超时 (120s)，继续启动其他服务")
    if output_lines:
        print(f"  {DIM}最近输出:{RESET}")
        for line in output_lines[-5:]:
            print(f"  {YELLOW}│{RESET} {line}")
        print()
    return proc


def _drain_output(proc: "subprocess.Popen", lines: list, color: str):
    """非阻塞地读取进程输出并显示。"""
    if proc.stdout is None:
        return

    if IS_WINDOWS:
        # Windows: 在单独线程中读取（简单回退）
        return

    import select as _select
    try:
        while True:
            ready, _, _ = _select.select([proc.stdout], [], [], 0)
            if not ready:
                break
            raw = proc.stdout.readline()
            if not raw:
                break
            text = raw.decode("utf-8", errors="replace").rstrip()
            if text:
                lines.append(text)
                print(f"  {color}[bridge]{RESET} {text}", flush=True)
    except (OSError, ValueError):
        pass


def _suggest_bridge_fix(output_lines: list):
    """根据错误输出给出修复建议。"""
    combined = "\n".join(output_lines[-30:]).lower()

    suggestions = []
    if "cannot find module" in combined or "module not found" in combined:
        suggestions.append("尝试运行: cd openclaw && pnpm install")
    if "eaddrinuse" in combined or "address already in use" in combined:
        suggestions.append("端口被占用，尝试: lsof -ti:18080 | xargs kill 或 lsof -ti:18789 | xargs kill")
    if "econnrefused" in combined and "5432" in combined:
        suggestions.append("PostgreSQL 未就绪，确认 Docker 容器正在运行")
    if "tsx" in combined and ("not found" in combined or "enoent" in combined):
        suggestions.append("tsx 未安装，尝试: npm install -g tsx")
    if "permission denied" in combined:
        suggestions.append("权限不足，检查文件权限")
    if "syntaxerror" in combined or "typeerror" in combined:
        suggestions.append("代码错误，检查 openclaw/bridge/ 下的源码")
    if "proxy" in combined and ("econnrefused" in combined or "connect" in combined):
        suggestions.append("LLM 代理连接失败，检查 .env 中的 API Key 配置")

    if not suggestions:
        suggestions.append("查看上方日志了解详情")
        suggestions.append("尝试手动运行: cd openclaw && npx tsx bridge/start.ts")

    print(f"  {YELLOW}💡 可能的解决方法:{RESET}")
    for s in suggestions:
        print(f"     • {s}")
    print()


# ── Platform Gateway ──────────────────────────────────────────────────

def start_gateway(env: dict) -> "subprocess.Popen | None":
    log("启动 Platform Gateway (端口 8080)...")

    if is_port_in_use(8080):
        warn("端口 8080 已被占用，跳过 gateway")
        return None

    proc_env = _base_env(
        PLATFORM_DATABASE_URL="postgresql+asyncpg://nanobot:nanobot@localhost:5432/nanobot_platform",
        # 本地开发模式：直接代理到本机 openclaw web，跳过 Docker 容器管理
        PLATFORM_DEV_OPENCLAW_URL="http://127.0.0.1:18080",
        # WebSocket 直连 OpenClaw Gateway（跳过 Bridge 的聊天中转）
        PLATFORM_DEV_GATEWAY_URL="ws://127.0.0.1:18789",
        **env,
    )

    # 从项目根目录 .env 读取配置并注入 PLATFORM_ 前缀
    # 需要转发的变量：所有 *_API_KEY、*_API_BASE、JWT_SECRET、DEFAULT_MODEL
    _EXTRA_ENV_KEYS = {"JWT_SECRET", "DEFAULT_MODEL", "ADMIN_USERNAME", "ADMIN_PASSWORD"}
    env_path = os.path.join(PROJECT_DIR, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip().strip("'\"")
                    if key.endswith(("_API_KEY", "_API_BASE")) or key in _EXTRA_ENV_KEYS:
                        platform_key = f"PLATFORM_{key}"
                        proc_env.setdefault(platform_key, val)

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "0.0.0.0", "--port", "8080", "--reload"],
        cwd=os.path.join(PROJECT_DIR, "platform"),
        env=proc_env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    log(f"  PID: {proc.pid}")

    # 短暂等待，检查是否立即崩溃（如依赖缺失、配置错误）
    time.sleep(2)
    if proc.poll() is not None:
        error(f"Platform Gateway 启动失败 (exit code: {proc.returncode})")
        if proc.stdout:
            raw = proc.stdout.read()
            if raw:
                text = raw.decode("utf-8", errors="replace").strip()
                output_lines = text.splitlines()
                last = output_lines[-10:]
                print()
                for line in last:
                    print(f"  {RED}│{RESET} {line}")
                print()
                combined = "\n".join(output_lines[-20:]).lower()
                if "no module named" in combined:
                    print(f"  {YELLOW}💡 Python 依赖缺失，尝试: cd platform && pip install -r requirements.txt{RESET}")
                elif "connection refused" in combined and "5432" in combined:
                    print(f"  {YELLOW}💡 数据库连接失败，确认 PostgreSQL 正在运行{RESET}")
                print()
        return None

    return proc


# ── Frontend Dev Server ───────────────────────────────────────────────

def start_frontend(frontend_host: str = "0.0.0.0", api_url: str = "http://127.0.0.1:8080") -> "subprocess.Popen | None":
    log("启动 Frontend Dev Server (端口 3080)...")

    if is_port_in_use(3080):
        warn("端口 3080 已被占用，跳过 frontend")
        return None

    frontend_dir = os.path.join(PROJECT_DIR, "frontend")

    if not os.path.exists(os.path.join(frontend_dir, "node_modules")):
        log("安装前端依赖...")
        # shell=True + 字符串命令在两个平台都能正确找到 npm / npm.cmd
        subprocess.run("npm install", cwd=frontend_dir, shell=True, check=True)

    # 让 vite 明确绑定到指定网卡，支持其他设备访问
    dev_cmd = f"npm run dev -- --host {frontend_host} --port 3080"
    proc = subprocess.Popen(
        dev_cmd,
        cwd=frontend_dir,
        env=_base_env(VITE_API_URL=api_url),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
        **({"start_new_session": True} if not IS_WINDOWS else {}),
    )
    log(f"  PID: {proc.pid}")
    return proc


# ── Manage Admin Dev Server ──────────────────────────────────────────

def start_manage(api_url: str = "http://127.0.0.1:8080") -> "subprocess.Popen | None":
    log("启动 Manage Admin Dev Server (端口 3081)...")

    if is_port_in_use(3081):
        warn("端口 3081 已被占用，跳过 manage")
        return None

    manage_dir = os.path.join(PROJECT_DIR, "manage_front")
    if not os.path.isdir(manage_dir):
        warn("manage_front 目录不存在，跳过 manage")
        return None

    if not os.path.exists(os.path.join(manage_dir, "node_modules")):
        log("安装管理端依赖...")
        subprocess.run("npm install", cwd=manage_dir, shell=True, check=True)

    dev_cmd = "npm run dev -- -p 3081"
    proc = subprocess.Popen(
        dev_cmd,
        cwd=manage_dir,
        env=_base_env(NEXT_PUBLIC_API_URL=api_url),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
        **({"start_new_session": True} if not IS_WINDOWS else {}),
    )
    log(f"  PID: {proc.pid}")
    return proc


# ── Simple Front Dev Server ───────────────────────────────────────────

def start_simple(frontend_host: str = "0.0.0.0", api_url: str = "http://127.0.0.1:8080") -> "subprocess.Popen | None":
    log("启动 Simple Front Dev Server (端口 3085)...")

    if is_port_in_use(3085):
        warn("端口 3085 已被占用，跳过 simple")
        return None

    simple_dir = os.path.join(PROJECT_DIR, "simple_front")

    if not os.path.exists(os.path.join(simple_dir, "node_modules")):
        log("安装 simple-front 依赖...")
        subprocess.run("npm install", cwd=simple_dir, shell=True, check=True)

    dev_cmd = f"npm run dev -- --host {frontend_host} --port 3085"
    proc = subprocess.Popen(
        dev_cmd,
        cwd=simple_dir,
        env=_base_env(VITE_API_URL=api_url),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        shell=True,
        **({"start_new_session": True} if not IS_WINDOWS else {}),
    )
    log(f"  PID: {proc.pid}")
    return proc


# ── 日志输出（跨平台：threading，不依赖 selectors/os.set_blocking）────

def tail_output(procs: dict):
    stop_event = threading.Event()

    def _reader(name: str, proc: "subprocess.Popen"):
        svc = SERVICES.get(name, {})
        color = svc.get("color", CYAN)
        try:
            for raw in iter(proc.stdout.readline, b""):
                if stop_event.is_set():
                    break
                text = raw.decode("utf-8", errors="replace").rstrip()
                if text:
                    print(f"{color}[{name:>8}]{RESET} {text}", flush=True)
        except (OSError, ValueError):
            pass

    threads = []
    for name, proc in procs.items():
        if proc and proc.stdout:
            t = threading.Thread(target=_reader, args=(name, proc), daemon=True)
            t.start()
            threads.append(t)

    try:
        while any(p.poll() is None for p in procs.values() if p):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        for t in threads:
            t.join(timeout=2)


# ── 停止所有服务 ──────────────────────────────────────────────────────

def stop_all():
    log("停止所有本地服务...")
    stop_postgres()

    if IS_WINDOWS:
        _stop_all_windows()
    else:
        _stop_all_unix()

    success("所有服务已停止")


def _stop_all_unix():
    patterns = ["bridge/start", "openclaw gateway", "uvicorn app.main:app", "vite.*3080", "vite.*3085", "next.*3081"]
    for pattern in patterns:
        result = subprocess.run(
            f"pgrep -f '{pattern}'",
            shell=True, capture_output=True, text=True,
        )
        for pid in result.stdout.strip().split("\n"):
            pid = pid.strip()
            if pid.isdigit():
                try:
                    os.kill(int(pid), signal.SIGTERM)
                    log(f"  终止进程 {pid} ({pattern})")
                except (ProcessLookupError, ValueError):
                    pass


def _stop_all_windows():
    # 进程名 → 用 tasklist 过滤
    image_names = ["openclaw.exe", "python.exe", "node.exe"]
    for image in image_names:
        try:
            result = subprocess.run(
                f'tasklist /FI "IMAGENAME eq {image}" /FO CSV /NH',
                shell=True, capture_output=True, text=True,
            )
            for line in result.stdout.strip().split("\n"):
                line = line.strip()
                if not line or line.startswith("INFO:") or "," not in line:
                    continue
                parts = line.split(",")
                if len(parts) >= 2:
                    pid = parts[1].strip('"').strip()
                    if pid.isdigit():
                        try:
                            os.kill(int(pid), signal.SIGTERM)
                            log(f"  终止进程 {pid} ({image})")
                        except (ProcessLookupError, PermissionError, OSError):
                            pass
        except Exception:
            pass


# ── deploy_copy 同步 ─────────────────────────────────────────────────

def sync_deploy_copy():
    """将 deploy_copy 目录中的模板文件同步到 ~/.openclaw/。

    仅在目标文件不存在时复制（不覆盖用户已有配置）。
    openclaw_defaults.json 中的配置项会合并到 openclaw.json（不覆盖已有项）。
    Agents/ 目录下的每个子目录会被注册为独立 Agent（创建 agents 目录 + workspace + 配置）。
    """
    deploy_dir = os.path.join(PROJECT_DIR, "deploy_copy")
    if not os.path.isdir(deploy_dir):
        return

    openclaw_home = os.path.join(os.path.expanduser("~"), ".openclaw")
    log("同步 deploy_copy 模板文件...")

    copied = 0

    # 1. 同步 Agents/ 目录 — 每个子目录注册为独立 Agent
    src_agents = os.path.join(deploy_dir, "Agents")
    if os.path.isdir(src_agents):
        copied += _sync_agents(src_agents, openclaw_home)

    # 2. 同步 skills/ 目录
    src_skills = os.path.join(deploy_dir, "skills")
    dst_skills = os.path.join(openclaw_home, "skills")
    if os.path.isdir(src_skills):
        os.makedirs(dst_skills, exist_ok=True)
        copied += _sync_dir(src_skills, dst_skills)

    # 3. 同步 extensions/ 目录（openclaw 插件）
    src_extensions = os.path.join(deploy_dir, "extensions")
    dst_extensions = os.path.join(openclaw_home, "extensions")
    if os.path.isdir(src_extensions):
        os.makedirs(dst_extensions, exist_ok=True)
        copied += _sync_dir(src_extensions, dst_extensions)

    # 4. 同步 SSH 密钥
    src_ssh = os.path.join(deploy_dir, "ssh")
    dst_ssh = os.path.join(os.path.expanduser("~"), ".ssh")
    if os.path.isdir(src_ssh):
        os.makedirs(dst_ssh, exist_ok=True)
        for f in os.listdir(src_ssh):
            src_file = os.path.join(src_ssh, f)
            dst_file = os.path.join(dst_ssh, f)
            if os.path.isfile(src_file) and not os.path.exists(dst_file):
                shutil.copy2(src_file, dst_file)
                # Set proper permissions
                if f.endswith('.pub') or f in ('config', 'known_hosts'):
                    os.chmod(dst_file, 0o644)
                else:
                    os.chmod(dst_file, 0o600)
                log(f"  + .ssh/{f}")
                copied += 1

    # 5. 合并 openclaw_defaults.json 到 openclaw.json
    defaults_path = os.path.join(deploy_dir, "openclaw_defaults.json")
    config_path = os.path.join(openclaw_home, "openclaw.json")
    if os.path.isfile(defaults_path):
        _merge_openclaw_defaults(defaults_path, config_path)

    if copied > 0:
        success(f"同步了 {copied} 个模板文件到 ~/.openclaw/")
    else:
        success("deploy_copy 模板已就绪（无新文件需同步）")


def _sync_agents(src_agents_dir: str, openclaw_home: str) -> int:
    """将 deploy_copy/Agents/ 下的每个子目录注册为独立 Agent。

    对每个 agent（如 hr, researcher, programmer）：
    1. 创建 ~/.openclaw/agents/<name>/ 目录（供 gateway 磁盘发现）
    2. 创建 ~/.openclaw/workspace-<name>/ 并同步 SOUL.md 等工作区文件
    3. 在 openclaw.json 的 agents.list 中注册（workspace 路径 + 名称）
    """
    copied = 0
    config_path = os.path.join(openclaw_home, "openclaw.json")
    agents_to_register = []

    for entry in sorted(os.listdir(src_agents_dir)):
        src_agent = os.path.join(src_agents_dir, entry)
        if not os.path.isdir(src_agent):
            continue

        agent_id = entry.lower()
        agent_display_name = _read_agent_display_name(src_agent, entry)

        # 1. 创建 agents/<id>/ 目录（gateway 会扫描此目录发现 agent）
        agent_dir = os.path.join(openclaw_home, "agents", agent_id)
        os.makedirs(agent_dir, exist_ok=True)

        # 2. 同步工作区文件到 workspace-<id>/
        workspace_dir = os.path.join(openclaw_home, f"workspace-{agent_id}")
        os.makedirs(workspace_dir, exist_ok=True)
        copied += _sync_dir(src_agent, workspace_dir)

        # 3. 记录待注册的 agent
        agents_to_register.append({
            "id": agent_id,
            "name": agent_display_name,
            "workspace": workspace_dir,
        })

    # 确保默认的 main agent 始终被注册
    # main 使用默认 workspace（~/.openclaw/workspace），不需要 workspace-main
    main_agent_dir = os.path.join(openclaw_home, "agents", "main")
    main_workspace = os.path.join(openclaw_home, "workspace")
    if os.path.isdir(main_agent_dir) or os.path.isdir(main_workspace):
        # 只在还没有被自定义 agent 覆盖时添加
        if not any(a["id"] == "main" for a in agents_to_register):
            agents_to_register.insert(0, {
                "id": "main",
                "name": "main",
                "workspace": main_workspace,
                "default": True,
            })

    # 批量注册到 openclaw.json
    if agents_to_register:
        _register_agents_in_config(config_path, agents_to_register)

    return copied


def _read_agent_display_name(src_agent_dir: str, fallback: str) -> str:
    """从模板 IDENTITY.md 的一级标题读取 Agent 展示名。"""
    identity_path = os.path.join(src_agent_dir, "IDENTITY.md")
    try:
        with open(identity_path, encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith("# "):
                    name = stripped[2:].strip()
                    if name:
                        return name
    except OSError:
        pass
    return fallback


def _register_agents_in_config(config_path: str, agents: list):
    """将 agent 列表注册到 openclaw.json 的 agents.list 中（不覆盖已有条目）。"""
    if not os.path.isfile(config_path):
        return

    try:
        with open(config_path) as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError):
        return

    if "agents" not in config:
        config["agents"] = {}
    if "list" not in config["agents"]:
        config["agents"]["list"] = []

    existing_ids = {
        entry.get("id", "").lower()
        for entry in config["agents"]["list"]
        if isinstance(entry, dict)
    }

    changed = False
    for agent in agents:
        if agent["id"] not in existing_ids:
            entry = {
                "id": agent["id"],
                "name": agent["name"],
                "workspace": agent["workspace"],
            }
            if agent.get("default"):
                entry["default"] = True
            config["agents"]["list"].append(entry)
            log(f"  注册 Agent: {agent['name']} (workspace: ~/{os.path.relpath(agent['workspace'], os.path.expanduser('~'))})")
            changed = True

    if changed:
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)


def _sync_dir(src: str, dst: str) -> int:
    """递归同步目录，仅复制目标不存在的文件。返回复制的文件数。"""
    copied = 0
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        dst_root = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(dst_root, exist_ok=True)
        for f in files:
            src_file = os.path.join(root, f)
            dst_file = os.path.join(dst_root, f)
            if not os.path.exists(dst_file):
                shutil.copy2(src_file, dst_file)
                log(f"  + {os.path.relpath(dst_file, os.path.expanduser('~'))}")
                copied += 1
    return copied


def _deep_merge(base: dict, override: dict) -> bool:
    """递归深度合并 override 到 base（不覆盖 base 已有的叶子值）。

    对于 list 类型：如果两边都是 list[dict] 且元素有 "id" 字段，
    按 id 匹配后递归合并每个元素；否则保留 base 的值不覆盖。
    返回是否有变更。
    """
    changed = False
    for key, value in override.items():
        if key not in base:
            # base 中不存在，直接用 override 的值（深拷贝）
            import copy
            base[key] = copy.deepcopy(value)
            changed = True
        elif isinstance(value, dict) and isinstance(base[key], dict):
            # 两边都是 dict，递归合并
            if _deep_merge(base[key], value):
                changed = True
        elif isinstance(value, list) and isinstance(base[key], list):
            # 两边都是 list：尝试按 id 匹配合并（适用于 agents.list）
            if (value and isinstance(value[0], dict) and "id" in value[0]
                    and base[key] and isinstance(base[key][0], dict) and "id" in base[key][0]):
                base_by_id = {item["id"]: item for item in base[key] if isinstance(item, dict) and "id" in item}
                for override_item in value:
                    if not isinstance(override_item, dict) or "id" not in override_item:
                        continue
                    item_id = override_item["id"]
                    if item_id in base_by_id:
                        # 已有同 id 条目，递归合并其字段
                        if _deep_merge(base_by_id[item_id], override_item):
                            changed = True
                    else:
                        # base 中没有此 id，追加
                        import copy
                        base[key].append(copy.deepcopy(override_item))
                        changed = True
            # 其他 list 情况：保留 base 的值，不覆盖
        # 其他类型（str, int, bool 等）：base 已有值，不覆盖
    return changed


def _merge_openclaw_defaults(defaults_path: str, config_path: str):
    """将 defaults 中的配置项深度合并到 openclaw.json（不覆盖已有叶子值）。

    如果 openclaw.json 不存在，直接深拷贝 defaults 作为初始配置。
    """
    try:
        with open(defaults_path) as f:
            defaults = json.load(f)
    except (json.JSONDecodeError, OSError):
        return

    if not os.path.isfile(config_path):
        # 配置文件不存在，直接用 defaults 创建
        os.makedirs(os.path.dirname(config_path), exist_ok=True)
        with open(config_path, "w") as f:
            json.dump(defaults, f, indent=2, ensure_ascii=False)
        log("  从 openclaw_defaults.json 创建 openclaw.json")
        return

    try:
        with open(config_path) as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError):
        return

    if _deep_merge(config, defaults):
        with open(config_path, "w") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        log("  深度合并 openclaw_defaults.json → openclaw.json")


# ── 主入口 ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="OpenClaw 本地开发启动脚本")
    parser.add_argument("--stop", action="store_true", help="停止所有本地服务")
    parser.add_argument("--only", type=str, help="仅启动指定服务，逗号分隔 (db,bridge,gateway,frontend,manage,simple)")
    parser.add_argument("--skip", type=str, help="跳过指定服务，逗号分隔")
    parser.add_argument("--no-tail", action="store_true", help="不跟踪日志输出")
    parser.add_argument(
        "--public",
        action="store_true",
        help="开启局域网访问（frontend 绑定 0.0.0.0，并自动使用本机 LAN IP 作为 API 地址）",
    )
    parser.add_argument(
        "--local-only",
        action="store_true",
        help="强制仅本机访问（frontend 绑定 127.0.0.1，API 使用 127.0.0.1）",
    )
    parser.add_argument(
        "--frontend-host",
        type=str,
        default="",
        help="前端 dev server 绑定地址（默认自动 0.0.0.0，可手动指定）",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default="",
        help="前端访问的 Gateway 地址（默认自动使用探测到的局域网 IP）",
    )
    args = parser.parse_args()

    if args.stop:
        stop_all()
        return

    # 解析要启动的服务
    all_services = ["db", "bridge", "gateway", "frontend", "manage", "simple"]
    enabled = [s.strip() for s in args.only.split(",")] if args.only else list(all_services)
    if args.skip:
        skip = {s.strip() for s in args.skip.split(",")}
        enabled = [s for s in enabled if s not in skip]

    platform_label = "Windows" if IS_WINDOWS else ("macOS" if sys.platform == "darwin" else "Linux")
    print(f"\n{BOLD}🔧 OpenClaw 本地开发环境 ({platform_label}){RESET}\n")

    # 同步 deploy_copy 模板文件到 ~/.openclaw/, 用于部署时初始化，方便新用户不必每次都安装
    sync_deploy_copy()
    print()

    # ── 网络模式 ──────────────────────────────────────────────────────
    lan_ip = _detect_lan_ip()

    # 前端监听地址：手动指定 > local-only > 默认公网友好(0.0.0.0)
    if args.frontend_host:
        frontend_host = args.frontend_host
    elif args.local_only:
        frontend_host = "127.0.0.1"
    else:
        frontend_host = "0.0.0.0"

    # 前端 API 地址：手动指定 > local-only > 默认使用探测 LAN IP
    if args.api_url:
        frontend_api_url = args.api_url.rstrip("/")
    elif args.local_only:
        frontend_api_url = "http://127.0.0.1:8080"
    else:
        frontend_api_url = f"http://{lan_ip}:8080"

    # 启动前打印网络模式与 IP 探测结果，便于排障
    log(f"探测到局域网 IP: {lan_ip}")
    mode_label = "局域网可访问" if not args.local_only else "仅本机访问"
    log(f"访问模式: {mode_label}")
    if lan_ip == "127.0.0.1" and not args.local_only:
        warn("未探测到有效局域网 IP，已回退到 127.0.0.1；如需外部访问请手动指定 --api-url")

    log(f"启动服务: {', '.join(enabled)}")

    processes: dict = {}
    extra_env: dict = {}

    # Read .env and forward model config to bridge
    env_path = os.path.join(PROJECT_DIR, ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    key, val = key.strip(), val.strip().strip("'\"")
                    if key == "DEFAULT_MODEL" and val:
                        # Strip provider prefix (e.g. "dashscope/qwen3-coder-plus" → "qwen3-coder-plus")
                        model = val.split("/", 1)[-1] if "/" in val else val
                        extra_env["NANOBOT_AGENTS__DEFAULTS__MODEL"] = model

    try:
        # 1. PostgreSQL
        if "db" in enabled:
            result = subprocess.run("docker info", shell=True, capture_output=True)
            if result.returncode != 0:
                error("Docker 未运行，无法启动 PostgreSQL")
                error("请先启动 Docker，或使用 --skip db 跳过")
                sys.exit(1)
            if not start_postgres():
                sys.exit(1)

        # 2. OpenClaw Bridge 后端（含就绪等待，gateway 代理依赖它）
        if "bridge" in enabled:
            proc = start_bridge(extra_env)
            if proc:
                processes["bridge"] = proc

        # 3. Platform Gateway
        if "gateway" in enabled:
            proc = start_gateway(extra_env)
            if proc:
                processes["gateway"] = proc

        # 短暂等待 gateway 启动，frontend 依赖它
        if "gateway" in enabled and "frontend" in enabled:
            time.sleep(2)

        # 4. Frontend
        if "frontend" in enabled:
            proc = start_frontend(frontend_host=frontend_host, api_url=frontend_api_url)
            if proc:
                processes["frontend"] = proc

        # 5. Manage Admin
        if "manage" in enabled:
            proc = start_manage(api_url=frontend_api_url)
            if proc:
                processes["manage"] = proc

        # 6. Simple Front
        if "simple" in enabled:
            proc = start_simple(frontend_host=frontend_host, api_url=frontend_api_url)
            if proc:
                processes["simple"] = proc

        if not processes:
            success("所有服务已就绪（使用已有实例）")
            return

        # 打印访问信息
        display_host = "127.0.0.1" if args.local_only else lan_ip
        print(f"\n{BOLD}{'=' * 52}{RESET}")
        print(f"{BOLD}  本地开发环境已启动{RESET}")
        print(f"{'=' * 52}")
        for svc_id in enabled:
            svc = SERVICES[svc_id]
            if svc_id == "db":
                pid_info = "Docker 容器"
            elif svc_id in processes and processes[svc_id]:
                pid_info = f"PID {processes[svc_id].pid}"
            else:
                pid_info = "已有实例"
            print(f"  {svc['color']}{svc['name']:>20}{RESET}  http://{display_host}:{svc['port']}  ({pid_info})")
        if "frontend" in enabled:
            print(f"  {DIM}Frontend 绑定: {frontend_host} | VITE_API_URL={frontend_api_url}{RESET}")
        if not args.local_only and lan_ip != "127.0.0.1":
            print(f"  {DIM}局域网访问: http://{lan_ip}:3080{RESET}")
        print(f"{'=' * 52}")
        print(f"  {DIM}按 Ctrl+C 停止所有服务{RESET}\n")

        if not args.no_tail:
            tail_output(processes)
        else:
            # 等待所有进程
            for proc in processes.values():
                if proc:
                    proc.wait()

    except KeyboardInterrupt:
        print(f"\n\n{YELLOW}正在停止服务...{RESET}")
    finally:
        # 清理进程
        for name, proc in processes.items():
            if proc and proc.poll() is None:
                log(f"停止 {name} (PID {proc.pid})...")
                # shell=True + start_new_session 的进程需要 kill 整个进程组
                if not IS_WINDOWS and name == "frontend":
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    except (ProcessLookupError, PermissionError):
                        proc.terminate()
                else:
                    proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    if not IS_WINDOWS and name == "frontend":
                        try:
                            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                        except (ProcessLookupError, PermissionError):
                            proc.kill()
                    else:
                        proc.kill()

        # 如果启动了 db，也停止它
        if "db" in enabled:
            stop_postgres()

        success("所有服务已停止")


if __name__ == "__main__":
    main()
