import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const [toolingRoot,sdkRoot,destination]=process.argv.slice(2);
if(!toolingRoot||!sdkRoot||!destination)throw new Error('Supply esbuild tooling directory, SDK directory and build output directory');
const { build }=createRequire(resolve(toolingRoot,'package.json'))('esbuild');
const functionRoot=resolve(destination),out=resolve(functionRoot,'hlAdminCockpit');
await mkdir(out,{recursive:true});
const result=await build({entryPoints:[resolve(root,'cloudfunctions/hlAdminCockpit/index.js')],outfile:resolve(out,'index.js'),
  bundle:true,platform:'node',format:'cjs',target:'node20',nodePaths:[resolve(sdkRoot,'node_modules')],metafile:true,logLevel:'silent'});
if(result.warnings.length)throw new Error('Function bundle produced warnings; inspect before deployment');
const source=await readFile(resolve(out,'index.js'));
await writeFile(resolve(out,'package.json'),JSON.stringify({name:'hl-admin-cockpit-bundled',version:'1.0.0',private:true,main:'index.js'},null,2)+'\n');
const record={builtAt:new Date().toISOString(),functionName:'hlAdminCockpit',runtime:'Nodejs20.19',
  bundleSha256:createHash('sha256').update(source).digest('hex'),bundleBytes:source.length,
  inputFiles:Object.keys(result.metafile.inputs).map(path=>path.replaceAll('\\','/')),
  outputDirectory:out};
await writeFile(resolve(functionRoot,'build-manifest.json'),JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({functionRoot,bundleSha256:record.bundleSha256,bundleBytes:record.bundleBytes,warnings:0}));
