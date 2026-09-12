import { dirname, join } from 'node:path';

export function npmCommand(args, platform = process.platform, nodePath = process.execPath) {
  return platform === 'win32'
    ? { command: nodePath, args: [join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args] }
    : { command: 'npm', args };
}
