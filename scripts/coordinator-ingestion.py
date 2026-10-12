#!/usr/bin/env python3
"""Bounded map job discovery and detached supervisor control."""
import argparse
import json
import os
import sys
from coordinator_ingestion import snapshot, accept, start, release, command
from coordinator_ingestion import identifier

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('snapshot')
    adoption = commands.add_parser('accept')
    adoption.add_argument('--owner', default=os.environ.get('CODEX_THREAD_ID'))
    adoption.add_argument('--job', required=True)
    launch = commands.add_parser('start')
    launch.add_argument('--owner', default=os.environ.get('CODEX_THREAD_ID'))
    launch.add_argument('arguments', nargs=argparse.REMAINDER)
    finish = commands.add_parser('release')
    finish.add_argument('--intent', required=True)
    finish.add_argument('--evidence', required=True)
    stop = commands.add_parser('stop')
    stop.add_argument('--job', required=True)
    args = parser.parse_args()
    if args.command == 'snapshot': result = snapshot()
    elif args.command == 'accept': result = accept(args.owner, args.job)
    elif args.command == 'start':
        result = start(args.owner, args.arguments[1:] if args.arguments[:1] == ['--'] else args.arguments)
    elif args.command == 'release': result = release(args.intent, args.evidence)
    else:
        identifier(args.job)
        result = command(['ingest:supervise', 'stop', '--job', args.job])
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    os.umask(0o077)
    try: main()
    except (ValueError, OSError) as exc:
        print(f'Blocked: {exc}', file=sys.stderr)
        raise SystemExit(78)
