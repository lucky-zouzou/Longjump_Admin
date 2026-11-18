#!/usr/bin/env python3
"""Apply one reviewed backup manifest; never discover additional deletion targets."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import time


def apply_plan(plan_path, expected_sha, apply=False):
    plan_path = Path(plan_path)
    with os.fdopen(os.open(plan_path, os.O_RDONLY | os.O_NOFOLLOW)) as stream:
        raw = stream.read().encode()
    if hashlib.sha256(raw).hexdigest() != expected_sha:
        raise ValueError('Approved manifest changed')
    plan = json.loads(raw)
    age = time.time() - datetime.fromisoformat(plan['created_at'].replace('Z', '+00:00')).timestamp()
    if not 0 <= age <= 6 * 3600:
        raise ValueError('Manifest expired; inspect again')
    root = Path(plan['backup_dir'])
    if root.is_symlink() or not root.is_dir() or str(root.resolve()) != str(root):
        raise ValueError('Unexpected backup directory')
    keep, remove = plan['verified_keep'], plan['proposed_remove']
    if not keep or not remove:
        raise ValueError('Empty retained or removal set')
    all_names = [row['name'] for row in keep + remove]
    if len(set(all_names)) != len(all_names):
        raise ValueError('Duplicate or overlapping backup paths')
    if sum(row['bytes'] for row in remove) != plan['free_bytes']:
        raise ValueError('Size total mismatch')
    for row in remove:
        if not re.fullmatch(r'pre-[0-9a-f]{40}-(?:[0-9]+|recovery-[0-9]+)\.tar', row['name']):
            raise ValueError('Only approved release backup names can be removed')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        def check(row):
            if Path(row['name']).name != row['name'] or row['name'] in ('.', '..'):
                raise ValueError('Invalid backup name')
            current = os.stat(row['name'], dir_fd=directory, follow_symlinks=False)
            if not stat.S_ISREG(current.st_mode) or (current.st_size, current.st_mtime_ns, current.st_ino) != (row['bytes'], row['mtime_ns'], row['inode']):
                raise ValueError('Backup changed: ' + row['name'])

        # Validate every retained and removal file before unlinking any file.
        for row in keep + remove:
            check(row)
        result = {'dry_run': not apply, 'retained': len(keep), 'count': len(remove), 'bytes': plan['free_bytes']}
        if not apply:
            return result
        audit_path = plan_path.parent / ('applied-' + expected_sha + '.jsonl')
        with audit_path.open('x', encoding='utf8') as audit:
            def record(event):
                audit.write(json.dumps(event, ensure_ascii=False) + '\n')
                audit.flush()
                os.fsync(audit.fileno())
            record({'started_at': datetime.now(timezone.utc).isoformat(), 'manifest_sha256': expected_sha, 'approved': remove})
            for row in remove:
                check(row)
                os.unlink(row['name'], dir_fd=directory)
                os.fsync(directory)
                record({'removed': row['name'], 'bytes': row['bytes']})
            for row in keep:
                check(row)
            record({'completed_at': datetime.now(timezone.utc).isoformat(), **result})
        return {**result, 'audit_path': str(audit_path)}
    finally:
        os.close(directory)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True)
    parser.add_argument('--approved-sha256', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(apply_plan(args.plan, args.approved_sha256, args.apply), ensure_ascii=False))
