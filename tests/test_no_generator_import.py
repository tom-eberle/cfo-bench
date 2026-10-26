"""The public tree runs without the scenario generator.

The generator that produced `scenarios/atelier-lumen-s1` is not part of the public repository:
the harness, graders, report and tests read the frozen scenario from disk. Two checks:

- static: no Python file imports the generator module (`import`, `from … import`,
  `importlib.import_module` / `__import__` with a literal name). An import inside a `try` whose
  handler catches `ImportError` is an optional hook, not a dependency, and is allowed;
- at import time: with the generator made unimportable, every module of `bench` and every test
  module imports, and the command line builds and runs `--help`.
"""
from __future__ import annotations

import ast
import os
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = "bench.generator"
SKIP_DIRS = {".git", ".venv", "node_modules", "runs", "__pycache__", ".pytest_cache", "dist", "results"}


def python_files() -> list[Path]:
    files = sorted(
        p for p in ROOT.rglob("*.py")
        if not SKIP_DIRS.intersection(p.relative_to(ROOT).parts)
    )
    return files


def _is_private(name: str | None) -> bool:
    return bool(name) and (name == PRIVATE or name.startswith(PRIVATE + "."))


def _catches_import_error(node: ast.Try) -> bool:
    for h in node.handlers:
        names = []
        if h.type is None:
            return True
        for t in (h.type.elts if isinstance(h.type, ast.Tuple) else [h.type]):
            if isinstance(t, ast.Name):
                names.append(t.id)
        if {"ImportError", "ModuleNotFoundError", "Exception", "BaseException"} & set(names):
            return True
    return False


def private_imports(path: Path) -> list[str]:
    """Unguarded imports of the generator in one file, as `path:line: text`."""
    tree = ast.parse(path.read_text(), filename=str(path))
    guarded: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and _catches_import_error(node):
            for stmt in node.body:
                guarded.update(id(n) for n in ast.walk(stmt))
    hits = []
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            names = [node.module or ""] + [f"{node.module}.{a.name}" for a in node.names]
        elif isinstance(node, ast.Call):
            fn = node.func
            called = fn.attr if isinstance(fn, ast.Attribute) else fn.id if isinstance(fn, ast.Name) else ""
            if called in ("import_module", "__import__") and node.args and isinstance(node.args[0], ast.Constant):
                names = [str(node.args[0].value)]
        if any(_is_private(n) for n in names) and id(node) not in guarded:
            hits.append(f"{path.relative_to(ROOT)}:{node.lineno}: {ast.unparse(node)}")
    return hits


def test_no_public_file_imports_the_generator():
    files = python_files()
    assert any(p.parts[-2:] == ("bench", "cli.py") for p in files)
    hits = [h for p in files for h in private_imports(p)]
    assert hits == [], "imports of the generator:\n" + "\n".join(hits)


def test_the_scan_finds_imports(tmp_path, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "ROOT", tmp_path)
    src = tmp_path / "x.py"
    src.write_text(textwrap.dedent(f"""
        import importlib
        import {PRIVATE}.build
        from {PRIVATE} import model
        from bench import generator
        importlib.import_module("{PRIVATE}.truth")
        try:
            from {PRIVATE}.build import generate
        except ImportError:
            generate = None
    """))
    hits = private_imports(src)
    assert [h.split(":")[1] for h in hits] == ["3", "4", "5", "6"], hits


def test_everything_imports_and_runs_without_the_generator():
    modules = sorted(
        ".".join(p.relative_to(ROOT).with_suffix("").parts).removesuffix(".__init__")
        for p in python_files()
        if p.relative_to(ROOT).parts[0] in ("bench", "tests")
    )
    assert "bench.cli" in modules and "tests.test_grader_baselines" in modules
    script = textwrap.dedent(f"""
        import contextlib, importlib, importlib.abc, io, sys
        sys.path.insert(0, {str(ROOT)!r})
        sys.path.insert(1, {str(ROOT / "tests")!r})

        class Block(importlib.abc.MetaPathFinder):
            def find_spec(self, name, path=None, target=None):
                if name == {PRIVATE!r} or name.startswith({PRIVATE!r} + "."):
                    raise ModuleNotFoundError("blocked: " + name, name=name)
                return None

        sys.meta_path.insert(0, Block())
        for name in {modules!r}:
            importlib.import_module(name)
        assert not any(m == {PRIVATE!r} or m.startswith({PRIVATE!r} + ".") for m in sys.modules)

        from bench import cli
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            try:
                cli.main(["--help"])
            except SystemExit as e:
                assert e.code == 0, e.code
        out = buf.getvalue()
        for cmd in ("run", "selftest", "prepare-runtime", "grade", "report"):
            assert cmd in out, cmd
        assert "generate" not in out, out
        print("ok", len({modules!r}))
    """)
    r = subprocess.run([sys.executable, "-c", script], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.startswith("ok ")
