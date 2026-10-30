"""PyAV and NumPy load when first needed, once, under one lock."""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).parent.parent
_GATE = "load_media_libraries"


def _imports_media(statement: ast.stmt) -> bool:
    if isinstance(statement, ast.Import):
        return any(alias.name.split(".")[0] in ("av", "numpy") for alias in statement.names)
    if isinstance(statement, ast.ImportFrom):
        module = statement.module or ""
        return statement.level == 0 and module.split(".")[0] in ("av", "numpy")
    return False


def _calls_gate(statement: ast.stmt) -> bool:
    return (
        isinstance(statement, ast.Expr)
        and isinstance(statement.value, ast.Call)
        and isinstance(statement.value.func, ast.Name)
        and statement.value.func.id == _GATE
    )


def test_every_function_that_imports_pyav_or_numpy_loads_them_through_the_gate():
    # two threads importing PyAV at the same time can leave one with a half-loaded module
    ungated = []
    for path in sorted((_ROOT / "tuck").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for statement in node.body:
                if _calls_gate(statement):
                    break
                if _imports_media(statement):
                    ungated.append(f"{path.relative_to(_ROOT)}:{statement.lineno} {node.name}")
                    break
            for inner in ast.walk(node):
                nested_import = _imports_media(inner) if isinstance(inner, ast.stmt) else False
                if nested_import and inner not in node.body:
                    ungated.append(f"{path.relative_to(_ROOT)}:{inner.lineno} {node.name} (nested)")
    assert ungated == []


_FIRST_REQUEST_DURING_THE_BACKGROUND_LOAD = """
import threading

from tuck.cutting.exact import encoder_supports
from tuck.media_libraries import load_media_libraries

loader = threading.Thread(target=load_media_libraries)
loader.start()
print(encoder_supports("libx264", "yuv420p"))
loader.join()
"""


def test_a_request_during_the_background_load_waits_for_it():
    # a fresh interpreter, so PyAV isn't loaded yet when both start
    result = subprocess.run(
        [sys.executable, "-c", _FIRST_REQUEST_DURING_THE_BACKGROUND_LOAD],
        capture_output=True,
        text=True,
        cwd=_ROOT,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip() == "True"
