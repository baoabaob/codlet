import fs from 'node:fs';
import { snapshotArchive, snapshotPreserved } from './lib/native-source-snapshot.mjs';

const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!/^--(?:archive|directory|output|package-full-name|identity|evidence)$/.test(args[i]) || !args[i + 1] ||
      Object.hasOwn(options, args[i].slice(2))) throw Error('Use --archive FILE or --directory DIR, and --output NEW_DIR');
  options[args[i].slice(2)] = args[i + 1];
}
if (!!options.archive === !!options.directory) throw Error('Select exactly one archive or preserved directory');
const result = options.archive
  ? await snapshotArchive({ archive: options.archive, output: options.output, packageFullName: options['package-full-name'] })
  : snapshotPreserved({ ...options, identity: JSON.parse(fs.readFileSync(options.identity, 'utf8')) });
console.log(JSON.stringify({ output: options.output, identity: result.identity, files: result.files.length,
  bytes: result.files.reduce((sum, file) => sum + file.bytes, 0), coverage: result.coverage }, null, 2));
