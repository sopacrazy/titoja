import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
const skipped = new Set(['node_modules', '.git', '.openai', '.wrangler', '.sites-runtime', 'data', 'backups', 'coverage', 'dist']);
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks require manual review before publication: ' + relative(root, path));
    if (entry.isDirectory()) {
      if (skipped.has(entry.name) || path === resolve(root, 'public/vendor')) return [];
      return walk(path);
    }
    return [relative(root, path).replaceAll('\\', '/')];
  });
}
const files = [...new Set(git.status === 0 ? git.stdout.split('\0').filter(Boolean) : walk(root))];
const failures = [];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{30,})\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  /\blibfile_[0-9a-f]{16,}\b/,
  /\bfile_000000[0-9a-f]+\b/,
];
const textExtensions = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.html', '.css', '.sql', '.yml', '.yaml']);
for (const file of files) {
  if (/(^|\/)(?:\.env(?:\..+)?|\.npmrc|\.openai|\.wrangler|\.sites-runtime)(?:\/|$)/.test(file) && file !== '.env.example') failures.push({ file, issue: 'private configuration' });
  if (/\.(?:sqlite\d*|db|log|zip|pem|key)(?:-[a-z]+)?$/i.test(file)) failures.push({ file, issue: 'database, archive, credential or runtime artifact' });
  if (file.startsWith('data/') || file.startsWith('backups/')) failures.push({ file, issue: 'runtime data' });
  const path = resolve(root, file);
  if (!lstatSync(path).isFile()) { failures.push({ file, issue: 'not a regular file' }); continue; }
  if (!textExtensions.has(extname(file)) && file !== '.env.example') continue;
  const text = readFileSync(path, 'utf8');
  if (text.includes('\uFFFD')) failures.push({ file, issue: 'invalid or damaged UTF-8' });
  for (const pattern of secretPatterns) if (pattern.test(text)) failures.push({ file, issue: 'possible secret or private platform identifier' });
  if (/^(?:server|client|public)\//.test(file) && /cloudflare:workers|oai-authenticated-user|signin-with-chatgpt|signout-with-chatgpt/.test(text)) failures.push({ file, issue: 'active platform-specific integration' });
}
if (failures.length) {
  console.error(JSON.stringify({ passed: false, findings: failures }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ passed: true, filesReviewed: files.length, note: 'Automated check complements manual review; no file contents or secrets printed.' }));
