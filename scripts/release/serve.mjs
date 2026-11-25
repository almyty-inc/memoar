#!/usr/bin/env node
// A static file server for the release verification jobs.
//
//   node scripts/release/serve.mjs <directory> <port>
//
// It serves <directory> the way a GitHub Release serves assets, so the
// launcher, install.sh, install.ps1 and the Homebrew formula can be pointed at
// unpublished artifacts with MEMOAR_DOWNLOAD_BASE=http://127.0.0.1:<port>.
// No dependencies, so it runs the same on all three runner operating systems.
// GET /__ready answers 200 once the socket is listening.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';

const [directory, port] = process.argv.slice(2);
if (!directory || !port) {
  console.error('usage: serve.mjs <directory> <port>');
  process.exit(2);
}
const root = resolve(directory);

createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (pathname === '/__ready') {
    response.writeHead(200).end('ready\n');
    return;
  }
  const file = resolve(root, `.${pathname}`);
  let size = -1;
  try {
    const stat = statSync(file);
    if (stat.isFile()) size = stat.size;
  } catch {
    size = -1;
  }
  if ((file !== root && !file.startsWith(root + sep)) || size < 0) {
    response.writeHead(404).end('not found\n');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}).listen(Number(port), '127.0.0.1', () => {
  console.log(`serving ${root} on http://127.0.0.1:${port}`);
});
