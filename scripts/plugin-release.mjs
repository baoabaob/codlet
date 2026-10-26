#!/usr/bin/env node
import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify} from 'node:crypto';
import {readFile, writeFile, mkdir, readdir, lstat, realpath, rename, unlink} from 'node:fs/promises';
import {resolve, dirname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {deflateRawSync} from 'node:zlib';

export const SOURCE_FILE = 'codlet-update.json';
export const FEED_FILE = 'codlet-updates.json';
const context = Buffer.from('Codlet plugin update v1\n');
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const pluginPattern = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('Update manifests only support safe integer numbers');
  if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) throw Error('Unsupported manifest value');
  return JSON.stringify(value);
}

export function repositoryUrl(value) {
  const name = value.replace(/^https:\/\/github\.com\//, '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9._-]{1,100}$/.test(name) || name.endsWith('.git') || name.endsWith('.')) throw Error('Use a public GitHub repository: owner/repository');
  return `https://github.com/${name}`;
}

function rawKey(value) {
  if (typeof value !== 'string') throw Error('Missing Ed25519 public key');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) throw Error('Ed25519 public keys must be 32 bytes in canonical base64');
  return bytes;
}

export function publicKeyFor(privateKey) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw Error('Use an Ed25519 signing key');
  const exported = createPublicKey(key).export({format:'der', type:'spki'});
  if (exported.length !== 44 || !exported.subarray(0, 12).equals(spkiPrefix)) throw Error('Invalid Ed25519 key encoding');
  return exported.subarray(12).toString('base64');
}

export function validateUpdateSource(source, repository) {
  const base = repositoryUrl(repository);
  if (!source || Object.keys(source).sort().join(',') !== 'manifestUrl,publicKey,schema' || source.schema !== 1) throw Error('Invalid codlet-update.json source schema');
  rawKey(source.publicKey);
  const value = source.manifestUrl;
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\%?#]/.test(value) || value.includes('/../') || value.includes('/./')) throw Error('Invalid update manifest URL');
  const url = new URL(value);
  const parts = url.pathname.slice(1).split('/');
  const repositoryParts = base.slice('https://github.com/'.length).split('/');
  if (url.protocol !== 'https:' || url.username || url.password || url.port || parts.some(part => !part || part === '.' || part === '..') || parts[0]?.toLowerCase() !== repositoryParts[0] || parts[1]?.toLowerCase() !== repositoryParts[1] || parts.at(-1) !== FEED_FILE) throw Error('Update manifest must be a public HTTPS file in the selected repository');
  const allowed = url.hostname === 'github.com'
    ? parts.length >= 6 && parts[2] === 'releases' && (parts[3] === 'download' || parts[3] === 'latest' && parts.length === 6 && parts[4] === 'download')
    : url.hostname === 'raw.githubusercontent.com' && parts.length >= 4;
  if (!allowed) throw Error('Use a direct GitHub Release file or raw repository file, not an API endpoint');
  return source;
}

export function createUpdateSource({repository, privateKey, publicKey, manifestUrl}) {
  const base = repositoryUrl(repository);
  return validateUpdateSource({
    schema:1,
    manifestUrl:manifestUrl ?? `${base}/releases/latest/download/${FEED_FILE}`,
    publicKey:publicKey ?? publicKeyFor(privateKey),
  }, base);
}

function validatePayload(payload, repository) {
  if (!payload || Object.keys(payload).sort().join(',') !== 'asset,id,repositoryUrl,tag,version' ||
      typeof payload.id !== 'string' || payload.id.length > 128 || !pluginPattern.test(payload.id) ||
      typeof payload.version !== 'string' || payload.version.length > 64 || !versionPattern.test(payload.version) ||
      payload.version.split('+')[0].split('-').slice(1).join('-').split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0') ||
      payload.repositoryUrl !== repositoryUrl(repository) || payload.tag !== `v${payload.version}`) throw Error('Invalid plugin update identity or semantic version');
  const asset = payload.asset;
  if (!asset || Object.keys(asset).sort().join(',') !== 'bytes,name,sha256,url' ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 32 * 1024 * 1024 ||
      typeof asset.name !== 'string' || asset.name.length > 255 || !asset.name.toLowerCase().endsWith('.zip') || /[\/\\:\x00-\x1f]/.test(asset.name) ||
      !/^[0-9a-f]{64}$/.test(asset.sha256)) throw Error('Invalid update archive identity');
  const expected = `${payload.repositoryUrl}/releases/download/${encodeURIComponent(payload.tag)}/${encodeURIComponent(asset.name)}`;
  if (asset.url !== expected) throw Error('The ZIP must use its immutable direct Release download URL');
}

export function createSignedUpdate({manifest, repository, assetName, archive, privateKey}) {
  const payload = {
    id:manifest.id,
    version:manifest.version,
    repositoryUrl:repositoryUrl(repository),
    tag:`v${manifest.version}`,
    asset:{
      name:assetName,
      url:`${repositoryUrl(repository)}/releases/download/${encodeURIComponent(`v${manifest.version}`)}/${encodeURIComponent(assetName)}`,
      bytes:archive.length,
      sha256:hash(archive),
    },
  };
  validatePayload(payload, repository);
  const key = createPrivateKey(privateKey);
  return {
    payload,
    publicKey:publicKeyFor(privateKey),
    signature:sign(null, Buffer.concat([context, Buffer.from(canonical(payload))]), key).toString('base64'),
  };
}

export function verifyUpdate(entry, repository, trustedKey) {
  if (!entry || Object.keys(entry).sort().join(',') !== 'payload,publicKey,signature') throw Error('Invalid signed update entry');
  validatePayload(entry.payload, repository);
  const publicKey = rawKey(entry.publicKey);
  if (trustedKey !== undefined && trustedKey !== entry.publicKey) throw Error('The plugin update signing key changed');
  const signature = Buffer.from(entry.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== entry.signature) throw Error('Invalid Ed25519 update signature encoding');
  const key = createPublicKey({key:Buffer.concat([spkiPrefix, publicKey]), format:'der', type:'spki'});
  if (!verify(null, Buffer.concat([context, Buffer.from(canonical(entry.payload))]), key, signature)) throw Error('Invalid plugin update signature');
  return entry;
}

export function validateUpdateManifest(value, repository) {
  if (!value || Object.keys(value).sort().join(',') !== 'kind,plugins,schema' || value.schema !== 1 || value.kind !== 'codlet-plugin-updates' ||
      !Array.isArray(value.plugins) || !value.plugins.length || value.plugins.length > 128 ||
      Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw Error('Invalid plugin update manifest schema or size');
  const identities = new Set();
  for (const entry of value.plugins) {
    verifyUpdate(entry, repository);
    const identity = `${entry.payload.id}/${entry.payload.version}`;
    if (identities.has(identity)) throw Error('Duplicate plugin/version in update manifest');
    identities.add(identity);
  }
  return value;
}

export function createUpdateManifest(entries, repository, previous) {
  const plugins = previous ? [...validateUpdateManifest(previous, repository).plugins] : [];
  for (const entry of entries) {
    verifyUpdate(entry, repository);
    const prior = plugins.filter(value => value.payload.id === entry.payload.id);
    if (prior.some(value => value.publicKey !== entry.publicKey)) throw Error('Retain the existing publisher signing key');
    const exact = prior.find(value => value.payload.version === entry.payload.version);
    if (exact && canonical(exact) !== canonical(entry)) throw Error('Published plugin versions are immutable');
    if (!exact) plugins.push(entry);
  }
  const latest = new Map();
  for (const entry of plugins) {
    const channel = entry.payload.version.split('+')[0].includes('-') ? 'preview' : 'stable';
    const key = `${entry.payload.id}/${channel}`;
    if (!latest.has(key) || compareVersions(entry.payload.version, latest.get(key).payload.version) > 0) latest.set(key,entry);
  }
  const retained = [...latest.values()].sort((a,b) => a.payload.id.localeCompare(b.payload.id, 'en') || compareVersions(a.payload.version,b.payload.version));
  return validateUpdateManifest({schema:1, kind:'codlet-plugin-updates', plugins:retained}, repository);
}

function compareVersions(left,right) {
  const a = versionPattern.exec(left), b = versionPattern.exec(right);
  for (let index=1;index<=3;index++) {
    const x = BigInt(a[index]), y = BigInt(b[index]);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1;
  const x = a[4].split('.'), y = b[4].split('.');
  for (let index=0;index<Math.max(x.length,y.length);index++) {
    if (x[index] === undefined || y[index] === undefined) return x[index] === undefined ? -1 : 1;
    if (x[index] === y[index]) continue;
    const xn = /^\d+$/.test(x[index]), yn = /^\d+$/.test(y[index]);
    if (xn && yn) return BigInt(x[index]) < BigInt(y[index]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit=0; bit<8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function zipPackage(files) {
  const body = [], central = [];
  let offset = 0;
  for (const [path, bytes] of files) {
    const name = Buffer.from(path), packed = deflateRawSync(bytes), crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(8,8); header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc,14); header.writeUInt32LE(packed.length,18); header.writeUInt32LE(bytes.length,22); header.writeUInt16LE(name.length,26);
    body.push(header,name,packed);
    const item = Buffer.alloc(46);
    item.writeUInt32LE(0x02014b50); item.writeUInt16LE(20,4); item.writeUInt16LE(20,6); item.writeUInt16LE(0x800,8); item.writeUInt16LE(8,10); item.writeUInt16LE(33,14);
    item.writeUInt32LE(crc,16); item.writeUInt32LE(packed.length,20); item.writeUInt32LE(bytes.length,24); item.writeUInt16LE(name.length,28); item.writeUInt32LE(offset,42);
    central.push(item,name); offset += header.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...body,directory,end]);
}

function inside(root, path) {
  const part = relative(root,path);
  return !part || !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\');
}

async function packageFiles(root) {
  const files = [];
  let total = 0;
  async function visit(folder, prefix='') {
    for (const entry of await readdir(folder,{withFileTypes:true})) {
      const name = prefix + entry.name;
      const path = resolve(folder,entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || await realpath(path) !== path) throw Error(`Linked package paths are not allowed: ${name}`);
      if (['.git','node_modules','.env','.codlet-source.json'].includes(entry.name) || /\.(pem|key|p12|pfx)$/i.test(entry.name)) throw Error(`Remove development files or credentials from the clean package directory: ${name}`);
      if (stat.isDirectory()) { await visit(path,`${name}/`); continue; }
      if (!stat.isFile()) throw Error(`Not a regular package file: ${name}`);
      const bytes = await readFile(path);
      total += bytes.length;
      if (files.length >= 2048 || total > 64*1024*1024) throw Error('Plugin package exceeds Core file or extracted-size limits');
      files.push([name.replaceAll('\\','/'),bytes]);
    }
  }
  await visit(root);
  return files;
}

export async function packPlugin({packageDirectory, repository, privateKeyPath, outputDirectory, manifestUrl, previousManifest}) {
  const sourceRoot = await realpath(resolve(packageDirectory));
  const keyPath = await realpath(resolve(privateKeyPath));
  const output = resolve(outputDirectory);
  if (inside(sourceRoot,keyPath) || inside(sourceRoot,output)) throw Error('Keep the private key and release output outside the package directory');
  const existing = await readdir(output).catch(error => {if(error.code==='ENOENT') return []; throw error;});
  if (existing.length) throw Error('Choose a new empty release output directory');
  const privateKey = await readFile(keyPath);
  const files = await packageFiles(sourceRoot);
  const fileMap = new Map(files);
  const manifest = JSON.parse(fileMap.get('codlet.json')?.toString() ?? 'null');
  if (!manifest || manifest.schema !== 1 || typeof manifest.id !== 'string' || !manifest.id || typeof manifest.version !== 'string' || !manifest.version || !manifest.renderer && !manifest.host) throw Error('The clean package needs a valid codlet.json and built entrypoint');
  for (const entry of [manifest.renderer?.entry,manifest.host?.entry].filter(Boolean)) {
    if (!fileMap.has(entry)) throw Error(`Missing built entrypoint: ${entry}`);
  }
  const existingSource = fileMap.has(SOURCE_FILE) ? JSON.parse(fileMap.get(SOURCE_FILE)) : null;
  const updateSource = createUpdateSource({
    repository, privateKey,
    manifestUrl:manifestUrl ?? existingSource?.manifestUrl,
  });
  if (manifest.version.split('+')[0].includes('-') && updateSource.manifestUrl === `${repositoryUrl(repository)}/releases/latest/download/${FEED_FILE}`) throw Error('Prerelease updates need a fixed static feed URL; pass --manifest-url for a raw repository file');
  if (existingSource && canonical(existingSource) !== canonical(updateSource)) throw Error('The existing update source differs from the requested signing key or feed; review it before changing publisher identity');
  fileMap.set(SOURCE_FILE,Buffer.from(JSON.stringify(updateSource,null,2)+'\n'));
  const metadata = fileMap.has('codlet-package.json') ? JSON.parse(fileMap.get('codlet-package.json')) : {schema:1,runtimeApi:1};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.schema !== 1) throw Error('Invalid codlet-package.json schema');
  if (!fileMap.has('codlet-package.json')) fileMap.set('codlet-package.json',Buffer.from(JSON.stringify(metadata,null,2)+'\n'));
  if (fileMap.size > 2048 || [...fileMap.values()].reduce((bytes,file)=>bytes+file.length,0) > 64*1024*1024) throw Error('Plugin package including update metadata exceeds Core file or extracted-size limits');
  const archive = zipPackage([...fileMap].sort(([a],[b]) => a.localeCompare(b,'en')));
  const assetName = `${manifest.id}-${manifest.version}.zip`;
  const signed = createSignedUpdate({manifest,repository,assetName,archive,privateKey});
  const feed = createUpdateManifest([signed],repository,previousManifest);
  const declaration = {schema:1,kind:'codlet-plugin-release',manifest,metadata,asset:{name:assetName,bytes:archive.length,sha256:hash(archive)}};
  const declarationBytes = Buffer.from(JSON.stringify(declaration,null,2)+'\n');
  if (declarationBytes.length > 16*1024) throw Error('codlet-release.json exceeds 16 KiB');
  await mkdir(output,{recursive:true});
  const artifacts = new Map([
    [assetName,archive],
    [FEED_FILE,Buffer.from(JSON.stringify(feed,null,2)+'\n')],
    ['codlet-release.json',declarationBytes],
  ]);
  for (const [name,bytes] of artifacts) await writeFile(resolve(output,name),bytes,{flag:'wx'});
  await writeFile(resolve(output,'SHA256SUMS.txt'),[...artifacts].map(([name,bytes]) => `${hash(bytes)}  ${name}`).join('\n')+'\n',{flag:'wx'});
  return {id:manifest.id,version:manifest.version,repository:repositoryUrl(repository),publicKey:updateSource.publicKey,manifestUrl:updateSource.manifestUrl,outputDirectory:output,assets:[...artifacts.keys()]};
}

function options(args) {
  const values = {};
  for (let index=0;index<args.length;index+=2) {
    const flag = args[index], value = args[index+1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--') || values[flag] !== undefined) throw Error('Use --option VALUE pairs');
    values[flag] = value;
  }
  return values;
}
async function main(args) {
  const command = args.shift(), opts = options(args);
  if (command === 'keygen') {
    if (!opts['--private-key'] || Object.keys(opts).length !== 1) throw Error('Usage: plugin-release.mjs keygen --private-key PATH');
    const path = resolve(opts['--private-key']);
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({format:'pem',type:'pkcs8'});
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,privateKey,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({privateKeyPath:path,publicKey:publicKeyFor(privateKey)},null,2));
    return;
  }
  if (command === 'pack') {
    const required = ['--package','--repository','--private-key','--output'];
    if (required.some(key => !opts[key]) || Object.keys(opts).some(key => ![...required,'--manifest-url','--previous'].includes(key))) throw Error('Usage: plugin-release.mjs pack --package DIR --repository OWNER/REPO --private-key PATH --output DIR [--manifest-url URL] [--previous MANIFEST]');
    const result = await packPlugin({
      packageDirectory:opts['--package'],repository:opts['--repository'],privateKeyPath:opts['--private-key'],outputDirectory:opts['--output'],manifestUrl:opts['--manifest-url'],
      previousManifest:opts['--previous'] ? JSON.parse(await readFile(opts['--previous'],'utf8')) : undefined,
    });
    console.log(JSON.stringify(result,null,2));
    return;
  }
  if (command === 'verify') {
    if (!opts['--manifest'] || !opts['--repository'] || Object.keys(opts).length !== 2) throw Error('Usage: plugin-release.mjs verify --manifest PATH --repository OWNER/REPO');
    const feed = validateUpdateManifest(JSON.parse(await readFile(opts['--manifest'],'utf8')),opts['--repository']);
    console.log(JSON.stringify({valid:true,plugins:feed.plugins.map(entry => ({id:entry.payload.id,version:entry.payload.version,publicKey:entry.publicKey}))},null,2));
    return;
  }
  if (command === 'merge') {
    const required = ['--incoming','--repository','--output'];
    if (required.some(key=>!opts[key]) || Object.keys(opts).some(key=>![...required,'--previous'].includes(key))) throw Error('Usage: plugin-release.mjs merge --incoming MANIFEST --repository OWNER/REPO --output FILE [--previous MANIFEST]');
    const pathIdentity=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
    if ([opts['--incoming'],opts['--previous']].filter(Boolean).some(path=>pathIdentity(path)===pathIdentity(opts['--output']))) throw Error('Merged channel output must not replace a versioned input');
    const incoming = validateUpdateManifest(JSON.parse(await readFile(opts['--incoming'],'utf8')),opts['--repository']);
    const previous = opts['--previous'] ? JSON.parse(await readFile(opts['--previous'],'utf8')) : undefined;
    const merged = createUpdateManifest(incoming.plugins,opts['--repository'],previous);
    const output=resolve(opts['--output']),parent=dirname(output);
    await mkdir(parent,{recursive:true});
    const outputInfo=await lstat(output).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(outputInfo&&(outputInfo.isSymbolicLink()||!outputInfo.isFile()||outputInfo.nlink!==1))throw Error('Merged channel output must be an ordinary unlinked file');
    const actualOutput=pathIdentity(outputInfo?await realpath(output):resolve(await realpath(parent),relative(parent,output)));
    for(const input of [opts['--incoming'],opts['--previous']].filter(Boolean)){
      const actualInput=await realpath(input),info=await lstat(actualInput);
      if(pathIdentity(actualInput)===actualOutput||outputInfo&&info.dev===outputInfo.dev&&info.ino===outputInfo.ino)throw Error('Merged channel output must not replace a versioned input');
    }
    const temporary=output+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify(merged,null,2)+'\n',{flag:'wx'});await rename(temporary,output);}
    finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    console.log(JSON.stringify({output:resolve(opts['--output']),plugins:merged.plugins.map(entry=>({id:entry.payload.id,version:entry.payload.version}))},null,2));
    return;
  }
  throw Error('Commands: keygen, pack, verify, merge. See docs/spec/plugin-updates.md.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
