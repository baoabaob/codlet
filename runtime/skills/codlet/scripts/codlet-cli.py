"""Invoke the Core that supplied this runtime skill, preserving its scope."""
import json
import os
from pathlib import Path
import subprocess
import sys

runtime = json.loads((Path(__file__).resolve().parent.parent / "runtime.json").read_text(encoding="utf-8"))
executable = runtime["cliExecutable"]
if not Path(executable).is_absolute():
    raise ValueError("Core CLI executable must be an absolute path")
environment = os.environ.copy()
environment["CODLET_HOME"] = os.path.dirname(runtime["registry"])
if os.name == "nt" and runtime.get("cliLocalAppData"):
    environment["LOCALAPPDATA"] = runtime["cliLocalAppData"]
raise SystemExit(subprocess.call([executable, *runtime["cliPrefix"], *sys.argv[1:]], env=environment))
