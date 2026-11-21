#!/usr/bin/env python3
"""Display the current Beads board without changing tracker state."""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def query(*args):
    result = subprocess.run(['bd', *args, '--json'], cwd=ROOT, check=True,
                            capture_output=True, text=True)
    return json.loads(result.stdout)


def main():
    issues = query('list', '--all', '--limit', '0')
    ready = {item['id'] for item in query('ready', '--limit', '0')}
    columns = {name: [] for name in ['Backlog', 'Ready', 'In progress', 'Review',
                                    'Blocked', 'Deferred', 'Done']}
    for issue in issues:
        status = issue['status']
        labels = issue.get('labels') or []
        if status == 'closed':
            column = 'Done'
        elif status == 'blocked':
            column = 'Blocked'
        elif status == 'deferred':
            column = 'Deferred'
        elif status == 'in_progress':
            column = 'Review' if 'stage:review' in labels else 'In progress'
        elif issue.get('issue_type') != 'epic' and issue['id'] in ready and not any(x.startswith('needs:') for x in labels):
            column = 'Ready'
        else:
            column = 'Backlog'
        columns[column].append(issue)
    for name, items in columns.items():
        print(f'\n{name} ({len(items)})')
        for item in sorted(items, key=lambda x: (x['priority'], x['id'])):
            owner = f" @{item['assignee']}" if item.get('assignee') else ''
            print(f"  {item['id']}  P{item['priority']}  {item['title']}{owner}")


if __name__ == '__main__':
    try:
        main()
    except (subprocess.CalledProcessError, FileNotFoundError, ValueError) as error:
        raise SystemExit(f'Cannot read Beads board: {error}') from error
