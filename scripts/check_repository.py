"""Validate tracked repository hygiene; this is not an application test suite."""

import pathlib
import subprocess
import sys


REQUIRED = {
    "README.md",
    "AGENTS.md",
    ".gitignore",
    ".gitattributes",
    ".github/pull_request_template.md",
    ".github/workflows/ci.yml",
    "docs/team-workflow.md",
    "scripts/check_repository.py",
}
DISPOSABLE_DIRS = {"node_modules", "__pycache__", ".venv", ".task-temp"}
PRIVATE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".db", ".sqlite", ".sqlite3"}


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    listing = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
    paths = [item.decode("utf-8") for item in listing.split(b"\0") if item]
    errors = [f"Missing required tracked file: {path}" for path in sorted(REQUIRED - set(paths))]
    for name in paths:
        path = pathlib.PurePosixPath(name)
        lower_name = path.name.lower()
        if any(part.lower() in DISPOSABLE_DIRS for part in path.parts):
            errors.append(f"Tracked temporary/dependency file: {name}")
        if (lower_name == ".env" or lower_name.startswith(".env.")) and not lower_name.endswith(".example"):
            errors.append(f"Tracked real environment configuration: {name}")
        if path.suffix.lower() in PRIVATE_SUFFIXES:
            errors.append(f"Tracked credential/database file: {name}")
        local = root / name
        if name in REQUIRED and (not local.is_file() or not local.read_bytes().strip()):
            errors.append(f"Required file missing or empty: {name}")
        if local.is_file() and local.stat().st_size > 10 * 1024 * 1024:
            errors.append(f"Tracked file exceeds 10 MiB; review artifact storage: {name}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"Repository hygiene passed ({len(paths)} tracked files).")
    print("Scope: required files, private filenames, temporary files, size and separate whitespace check.")
    print("Application tests/build/runtime and comprehensive secret scanning are not covered.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
