import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  quoteFixture,
  recoveryFixture,
  owner,
  token,
  contracts,
  now,
} from '../tests/fixtures/trails.js';

// Packaging + an isolated consumer only. This script has no publication/deployment command.
const output = resolve('.data/sdk-release');
mkdirSync(output, { recursive: true });
const packed = execFileSync(
  'npm',
  ['pack', './packages/server-wallet-sdk', '--pack-destination', output, '--json'],
  {
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(tmpdir(), 'oms-artifact-npm-cache') },
    stdio: ['ignore', 'pipe', 'inherit'],
  },
);
const [pack] = JSON.parse(packed) as {
  filename: string;
  name: string;
  version: string;
  integrity: string;
  files: { path: string }[];
}[];
if (
  pack.files.some(
    (f) =>
      !/^dist\//.test(f.path) &&
      !['package.json', 'README.md', 'CHANGELOG.md', 'NOTICE', 'LICENSE-APACHE-2.0'].includes(
        f.path,
      ),
  )
)
  throw new Error('Unexpected file in release archive');
const directory = mkdtempSync(join(tmpdir(), 'oms-sdk-consumer-'));
writeFileSync(
  join(directory, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@polygonlabs/oms-server-wallet-sdk': `file:${join(output, pack.filename)}`,
      typescript: '5.9.3',
    },
  }),
);
execFileSync('pnpm', ['--dir', directory, 'install', '--ignore-scripts'], { stdio: 'inherit' });
writeFileSync(
  join(directory, 'fixtures.json'),
  JSON.stringify({ ...quoteFixture(), prepared: recoveryFixture(), owner, token, contracts, now }),
);
writeFileSync(
  join(directory, 'consumer.ts'),
  `import { ServerWallet, SerialExecutor, type StateStore } from '@polygonlabs/oms-server-wallet-sdk';
import { WalletSwaps, EvmChainReader, TrailsClient, type SwapStore, type SwapRecord } from '@polygonlabs/oms-server-wallet-sdk/trails';
const records = new Map<string,SwapRecord>();
const store:SwapStore={get:async(id)=>records.get(id)??null,findIntent:async(intent)=>[...records.values()].find(r=>r.quote.intent.intentId===intent)?.id??null,save:async(r)=>{records.set(r.id,r);},list:async()=>[...records.values()]};
const state:StateStore={read:async()=>null,write:async()=>{}};
const wallet=new ServerWallet({subject:'consumer',issuer:'https://issuer.example',audience:'test',store:state,executor:new SerialExecutor(),transport:{request:async()=>{throw new Error('Offline consumer');}},tokenProvider:async()=>({token:'test',expiresAt:1})});
const swaps=new WalletSwaps({wallet,store,executor:new SerialExecutor(),trails:new TrailsClient({apiKey:'fixture'}),chains:new EvmChainReader({137:'https://rpc.example'}),assets:[],enabled:false,environment:'consumer'});
void swaps.listSwaps();
`,
);
writeFileSync(
  join(directory, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      lib: ['ES2022', 'DOM'],
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      outDir: 'dist',
    },
    include: ['consumer.ts'],
  }),
);
writeFileSync(
  join(directory, 'smoke.mjs'),
  `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ServerWallet, EncryptedStore, SerialExecutor } from '@polygonlabs/oms-server-wallet-sdk';
import { WalletSwaps, EvmChainReader, validateSwapQuote, validateRecoveryPayload, recoveryAuthorization } from '@polygonlabs/oms-server-wallet-sdk/trails';
const f=JSON.parse(fs.readFileSync(new URL('./fixtures.json',import.meta.url),'utf8'));
assert.equal((await validateSwapQuote(f.intent,f.request,f.contracts,f.now)).funding.amount,'10000000');
assert.equal(validateRecoveryPayload(f.prepared,f.intent,f.owner,[{asset:f.token,amount:'1000'}]).digest,f.prepared.payloadHash);
assert.deepEqual(recoveryAuthorization(f.prepared,f.intent,f.owner,[{asset:f.token,amount:'1000'}]),f.prepared);
const values=new Map();const encrypted=new EncryptedStore({read:async(k)=>values.get(k)??null,write:async(k,v)=>{values.set(k,v);}},btoa('k'.repeat(32)),'consumer');
await encrypted.write('check','private');assert.equal(await encrypted.read('check'),'private');assert(!values.get('check').includes('private'));
for(const item of [ServerWallet,SerialExecutor,WalletSwaps,EvmChainReader])assert.equal(typeof item,'function');
console.log('Clean artifact ESM, types, quotes, recovery codec and encryption passed.');
`,
);
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], {
  cwd: directory,
  stdio: 'inherit',
});
execFileSync(process.execPath, ['dist/consumer.js'], { cwd: directory, stdio: 'inherit' });
execFileSync(process.execPath, ['smoke.mjs'], { cwd: directory, stdio: 'inherit' });
const report = {
  name: pack.name,
  version: pack.version,
  integrity: pack.integrity,
  archive: join(output, pack.filename),
  files: pack.files.length,
  consumer: directory,
  verifiedAt: new Date().toISOString(),
};
// Assert the packaged version, rather than accidentally testing an existing workspace symlink.
const installed = JSON.parse(
  readFileSync(
    join(directory, 'node_modules/@polygonlabs/oms-server-wallet-sdk/package.json'),
    'utf8',
  ),
) as { version: string };
if (installed.version !== pack.version) throw new Error('Consumer resolved the wrong package');
writeFileSync(join(output, 'validation.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
