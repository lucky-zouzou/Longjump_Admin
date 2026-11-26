"""Install Feishu credentials from stdin without exposing them in logs or argv."""
import json
import os
import re
import sys
import tempfile
from pathlib import Path


def configure(root, value):
    try:
        data = json.loads(value)
        app_id = data["appId"].strip()
        app_secret = data["appSecret"].strip()
        if not re.fullmatch(r"cli_[A-Za-z0-9_-]{4,100}", app_id):
            raise ValueError()
        if not app_secret or len(app_secret) > 4096 or any(ord(c) < 32 for c in app_secret):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValueError("Invalid Feishu credentials") from None
    folder = Path(root) / "secrets" / "feishu"
    target = folder / "credentials.json"
    if folder.is_symlink() or folder.parent.is_symlink() or target.is_symlink():
        raise ValueError("Invalid private credential path")
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    with tempfile.NamedTemporaryFile(mode="w", dir=folder, delete=False) as handle:
        temp = Path(handle.name)
        try:
            json.dump({"appId": app_id, "appSecret": app_secret}, handle)
            handle.flush()
            os.fsync(handle.fileno())
            # Docker mounts this read-only file for the app's non-root UID;
            # the parent directory remains owner-only on the host.
            os.fchmod(handle.fileno(), 0o444)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        configure(Path.cwd(), sys.stdin.read(16385))
    except Exception:
        print("Feishu credential installation failed; check the private input and destination.", file=sys.stderr)
        sys.exit(1)
