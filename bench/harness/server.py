"""The fake Compta server (`server/`, API.md) as a context manager (one per batch).

The admin token is random per batch, given to the server through its environment and kept in
`.state/admin-token` inside the repo (git-ignored, unreadable from the sandbox). It is never
written into a run directory, an agent environment or argv.
"""

from __future__ import annotations

import json
import os
import secrets
import select
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from . import paths

#: Variables never passed to child processes (billing keys; inherited compta CLI settings).
SCRUBBED_ENV = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "COMPTA_SESSION", "COMPTA_COMPANY")


class ServerError(RuntimeError):
    pass


class FakeServer:
    def __init__(
        self,
        scenario: str | Path,
        *,
        log_path: str | Path | None = None,
        stderr_path: str | Path | None = None,
        node: str | Path | None = None,
        cert: Path | None = None,
        key: Path | None = None,
        ready_timeout: float = 20.0,
    ) -> None:
        self.scenario = Path(scenario).resolve()
        self.log_path = Path(log_path).resolve() if log_path else None
        self.stderr_path = Path(stderr_path) if stderr_path else None
        self.node = str(node or paths.node_binary())
        self.cert = cert or paths.CERTS_DIR / "server.pem"
        self.key = key or paths.CERTS_DIR / "server-key.pem"
        self.ready_timeout = ready_timeout
        self.token = secrets.token_hex(24)
        self.proc: subprocess.Popen[bytes] | None = None
        self.api_port = 0
        self.admin_port = 0
        self._stderr_file = None

    # ---- lifecycle -------------------------------------------------------------------------

    def __enter__(self) -> FakeServer:
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self) -> None:
        paths.STATE_DIR.mkdir(exist_ok=True)
        token_file = paths.STATE_DIR / "admin-token"
        fd = os.open(token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(self.token + "\n")
        env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_ENV}
        env["FRENCH_CFO_BENCH_ADMIN_TOKEN"] = self.token
        argv = [
            self.node, "server/src/main.ts",
            "--scenario", str(self.scenario),
            "--api-port", "0", "--admin-port", "0",
            "--cert", str(self.cert), "--key", str(self.key),
        ]  # fmt: skip
        if self.log_path:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            argv += ["--log", str(self.log_path)]
        if self.stderr_path:
            self.stderr_path.parent.mkdir(parents=True, exist_ok=True)
            self._stderr_file = self.stderr_path.open("ab")
        self.proc = subprocess.Popen(
            argv,
            cwd=paths.REPO_ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=self._stderr_file or subprocess.DEVNULL,
            start_new_session=True,
        )
        line = self._read_ready_line()
        try:
            ready = json.loads(line)
        except json.JSONDecodeError as e:
            self.stop()
            raise ServerError(f"unexpected server output: {line!r}") from e
        if not ready.get("ready"):
            self.stop()
            raise ServerError(f"server not ready: {line!r}")
        self.api_port = int(ready["apiPort"])
        self.admin_port = int(ready["adminPort"])
        # keep draining stdout so the pipe never fills
        threading.Thread(target=self._drain, daemon=True).start()
        self.health()

    def _read_ready_line(self) -> str:
        assert self.proc and self.proc.stdout
        deadline = time.monotonic() + self.ready_timeout
        buf = b""
        while b"\n" not in buf:
            left = deadline - time.monotonic()
            if left <= 0:
                self.stop()
                raise ServerError("fake server did not become ready")
            r, _, _ = select.select([self.proc.stdout], [], [], left)
            if r:
                chunk = os.read(self.proc.stdout.fileno(), 4096)
                if not chunk:
                    code = self.proc.poll()
                    self.stop()
                    raise ServerError(f"fake server exited early (code {code})")
                buf += chunk
        return buf.split(b"\n", 1)[0].decode()

    def _drain(self) -> None:
        assert self.proc and self.proc.stdout
        try:
            while self.proc.stdout.read(4096):
                pass
        except (OSError, ValueError):
            pass

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.proc.wait(timeout=5)
        if self._stderr_file:
            self._stderr_file.close()
            self._stderr_file = None

    # ---- admin API -------------------------------------------------------------------------

    def _call(self, method: str, path: str, body: Any = None, timeout: float = 30.0) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.admin_port}{path}",
            data=data,
            method=method,
            headers={"X-Admin-Token": self.token, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            raise ServerError(f"{method} {path}: {e.code} {e.read()[:500]!r}") from e

    def health(self) -> dict:
        return self._call("GET", "/__health")

    def reset(self, scenario: str | Path | None = None) -> dict:
        if scenario is not None:
            self.scenario = Path(scenario).resolve()
        return self._call("POST", "/__reset", {"scenario": str(self.scenario)})

    def state(self) -> dict:
        return self._call("GET", "/__state")

    def log(self) -> list[dict]:
        return self._call("GET", "/__log")

    def mark(self, label: str) -> dict:
        return self._call("POST", "/__mark", {"label": label})

    @property
    def api_base(self) -> str:
        return f"https://localhost:{self.api_port}"
