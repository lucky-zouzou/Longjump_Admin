#!/usr/bin/env python3
"""Provision only the website -> Admin bridge secret on the existing server."""
import os
from pathlib import Path
import re
import secrets
import sys


def configure(root):
    root = Path(root).resolve(strict=True)
    directory = root / 'secrets'
    if directory.is_symlink():
        raise ValueError('Refusing a symlinked secret directory')
    directory.mkdir(mode=0o700, exist_ok=True)
    target = directory / 'inquiry-sync.env'
    overlay = root / 'compose.inquiry-sync.yaml'
    expected_overlay = 'services:\n  app:\n    env_file:\n      - ./secrets/inquiry-sync.env\n'
    if overlay.is_symlink() or (overlay.exists() and overlay.read_text() != expected_overlay):
        raise ValueError('Existing inquiry compose overlay differs; review before changing it')
    if target.is_symlink():
        raise ValueError('Refusing a symlinked secret file')
    if not target.exists():
        value = 'LOONGJUMP_INQUIRY_SYNC_SECRET=' + secrets.token_urlsafe(48) + '\nLOONGJUMP_INQUIRY_SOURCE=loongjump-website\n'
        with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            handle.write(value)
    content = target.read_text()
    if not re.fullmatch(r'LOONGJUMP_INQUIRY_SYNC_SECRET=[A-Za-z0-9_-]{64}\nLOONGJUMP_INQUIRY_SOURCE=loongjump-website\n', content):
        raise ValueError('Existing bridge config is invalid; not rotating or printing it')
    target.chmod(0o600)
    if not overlay.exists():
        with os.fdopen(os.open(overlay, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as handle:
            handle.write(expected_overlay)
    print('Website inquiry bridge configuration ready; secret retained on server only')


if __name__ == '__main__':
    configure(sys.argv[1] if len(sys.argv) > 1 else '/root/loong-jump-v17')
