"""Install the dedicated employee assistant secret from stdin."""
import os
import re
import sys
import tempfile
from pathlib import Path

def configure(root, value):
    key = value.strip()
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{16,512}", key):
        raise ValueError("Invalid employee assistant API key")
    folder = Path(root) / "secrets" / "employee-assistant"
    target = folder / "api_key"
    if folder.is_symlink() or folder.parent.is_symlink() or target.is_symlink():
        raise ValueError("Invalid private key path")
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=folder, delete=False) as handle:
        temp = Path(handle.name)
        try:
            handle.write(key)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), 0o444)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)

if __name__ == "__main__":
    configure(Path.cwd(), sys.stdin.read(1024))
