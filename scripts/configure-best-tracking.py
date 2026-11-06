"""Install the private tracking credentials supplied on stdin, without logging them."""
import json
import os
import sys
import tempfile
from pathlib import Path


def configure(root, raw):
    data = json.loads(raw)
    if not isinstance(data, dict) or any(
        not isinstance(data.get(key), str) or not 1 <= len(data[key].strip()) <= 256
        for key in ('partnerId', 'secret')
    ):
        raise ValueError('Invalid BEST credential fields')
    directory = Path(root) / 'secrets' / 'best-tracking'
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError('Invalid secrets directory')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    target = directory / 'credentials.json'
    if target.is_symlink():
        raise ValueError('Invalid secret file')
    payload = json.dumps({key: data[key].strip() for key in ('partnerId', 'secret')})
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False) as handle:
        temp = Path(handle.name)
        try:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
            # Compose mounts just this file for the non-root application user.
            os.fchmod(handle.fileno(), 0o444)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)


if __name__ == '__main__':
    configure(Path.cwd(), sys.stdin.read(4097))
