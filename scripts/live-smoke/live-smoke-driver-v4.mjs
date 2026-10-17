// BTW installed-product live smoke driver v4. ONE run, no retry. Synthetic prompts only. Metadata-only receipt.
// Usage (live):  node live-smoke-driver-v4.mjs <stamp> <parent-allocation-id> <summary|ask>
// Usage (fake):  node live-smoke-driver-v4.mjs <stamp> FAKE-<id> <summary|ask> --fake --fake-pi=<script> --fake-base=http://127.0.0.1:<port> [--fake-variant=<v>]
// Request observation + the ENFORCED total request bound are wire-level (wire-observer.mjs via NODE_OPTIONS=--import), so the host,
// the native /btw child process and the in-process summarizer / ask SDK sessions are all covered. A request past the scenario cap is not sent.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {classify,ancestry,readRows,recapProcesses} from './heavy-overlap.mjs';
import {analyze,otherHosts,SCENARIOS,HARD_TOTAL_CAP,oauthMarginOk,MIN_OAUTH_REMAINING_S,childCrossCheck,assistantLines,RETRY_OVERRIDE_SETTINGS,EXTENSION_ISOLATION_SETTINGS,hostExtensionArgs} from './smoke-analysis.mjs';
const D=path.dirname(new URL(import.meta.url).pathname),NODE=process.execPath;
// Run evidence goes to BTW_SMOKE_OUT (default: a temp dir), never into the repository.
const OUT_ROOT=process.env.BTW_SMOKE_OUT||path.join(os.tmpdir(),'btw-live-smoke-runs');fs.mkdirSync(OUT_ROOT,{recursive:true});
const argv=process.argv.slice(2),flags=Object.fromEntries(argv.filter(a=>a.startsWith('--')).map(a=>{const[k,...v]=a.slice(2).split('=');return[k,v.length?v.join('='):true];}));
const [stamp,ALLOC,scenario]=argv.filter(a=>!a.startsWith('--'));
const FAKE=flags.fake===true;
assert(stamp&&/^[0-9A-Za-z-]{6,40}$/.test(stamp),'stamp');
assert(ALLOC&&/^[A-Za-z0-9._-]{6,80}$/.test(ALLOC),'a parent allocation id is required as argv[2]; self-allocation is not permitted');
assert(SCENARIOS[scenario],'scenario must be one of '+Object.keys(SCENARIOS).join('|'));
assert(FAKE===ALLOC.startsWith('FAKE-'),'allocation ids starting FAKE- are for --fake runs only, and --fake runs must use one');
const SPEC=SCENARIOS[scenario],CAP=Math.min(SPEC.cap,HARD_TOTAL_CAP);
if(FAKE){assert(flags['fake-pi']&&/^http:\/\/127\.0\.0\.1:\d+$/.test(String(flags['fake-base'])),'fake mode needs --fake-pi and a loopback --fake-base');}
const AG=FAKE?fs.mkdtempSync(os.tmpdir()+'/btw-fake-agent-'):os.homedir()+'/.pi/agent';
const PI=FAKE?String(flags['fake-pi']):AG+'/bin/pi',TRUSTED_ROOT=process.env.BTW_SMOKE_TRUSTED_ROOT||'';
const PROJ=FAKE?fs.mkdtempSync(os.tmpdir()+'/btw-fake-proj-'):TRUSTED_ROOT+'/_btw-live-smoke-'+stamp;
if(FAKE)for(const f of['auth.json','trust.json','settings.json'])fs.writeFileSync(AG+'/'+f,'{"fake":"'+f+'"}');
if(!FAKE){
 assert(path.isAbsolute(TRUSTED_ROOT),'live mode needs BTW_SMOKE_TRUSTED_ROOT=<absolute canonical directory that Pi already trusts>');
 assert(!fs.existsSync(PROJ),'smoke project directory already exists; refusing to reuse');
 const trustData=JSON.parse(fs.readFileSync(AG+'/trust.json','utf8'));let nearest;for(let d=PROJ;d!=='/'&&!nearest;d=path.dirname(d))if(trustData[d]===true)nearest=d;
 assert(nearest===TRUSTED_ROOT,'inherited trust must come from the existing '+TRUSTED_ROOT+' entry, got '+nearest);
 assert(fs.realpathSync(TRUSTED_ROOT)===TRUSTED_ROOT,'trusted root must be a canonical path, or Pi will not match the trust entry and will IGNORE the private no-retry override');
 for(let d=path.dirname(PROJ);d!=='/';d=path.dirname(d))for(const f of['AGENTS.md','CLAUDE.md','.pi'])assert(!fs.existsSync(d+'/'+f),'ancestor context/config would be loaded: '+d+'/'+f);
}
const sh=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const BTW_EXT=AG+'/git/github.com/cartwmic/pi-btw/extensions/btw.ts',GUARD_EXT=AG+'/extensions/claude-compat-guard/index.ts';
if(!FAKE)for(const f of[BTW_EXT,GUARD_EXT])assert(fs.existsSync(f),'required extension missing: '+f);
const HOST_EXT_ARGS=hostExtensionArgs(BTW_EXT,GUARD_EXT);
const out=path.join(OUT_ROOT,'run-'+stamp);assert(!fs.existsSync(out),'run directory exists');fs.mkdirSync(out);
// ---- preflight (read-only)
if(!FAKE){
 const rows=readRows(spawnSync),self=ancestry(rows,process.pid);
 const heavy=classify(rows,{exclude:self}).blocked.map(b=>b.rule+' pid '+b.pid+': '+b.command);
 const recap=recapProcesses(rows,{exclude:self});assert(recap.length===0,'a session-recap process is running (existing sessions can spike): '+recap.slice(0,2).map(l=>l.command.slice(0,80)).join(' | '));
 assert(heavy.length===0,'heavy workload present: '+heavy.slice(0,2).map(l=>l.slice(0,80)).join(' | '));
 const pr=()=>Number(spawnSync('/usr/sbin/sysctl',['-n','kern.memorystatus_vm_pressure_level'],{encoding:'utf8'}).stdout);
 const sw=()=>Number((spawnSync('/usr/sbin/sysctl',['-n','vm.swapusage'],{encoding:'utf8'}).stdout.match(/used = ([0-9.]+)M/)||[])[1]);
 const so=()=>Number((spawnSync('/usr/bin/vm_stat',[],{encoding:'utf8'}).stdout.match(/Swapouts:\s+(\d+)/)||[])[1]);
 const s1={p:pr(),sw:sw(),so:so()};await new Promise(r=>setTimeout(r,20000));const s2={p:pr(),sw:sw(),so:so()};
 assert(s1.p===1&&s2.p===1&&s2.so<=s1.so+50&&s2.sw<=s1.sw+16,'resource gate failed '+JSON.stringify([s1,s2]));
 const auth=JSON.parse(fs.readFileSync(AG+'/auth.json','utf8')).anthropic;assert(auth&&auth.type==='oauth','existing subscription OAuth login required');
 assert(oauthMarginOk(auth.expires,Date.now()),'anthropic OAuth has <= '+MIN_OAUTH_REMAINING_S/60+' minutes left (or an unreadable expiry): a refresh could write auth.json; not running');
}
const before={auth:sh(AG+'/auth.json'),trust:sh(AG+'/trust.json'),settings:sh(AG+'/settings.json'),btwDirs:fs.existsSync(AG+'/btw-native')?fs.readdirSync(AG+'/btw-native'):[]};
if(!FAKE){fs.mkdirSync(PROJ);}
fs.writeFileSync(PROJ+'/README.txt','synthetic empty project for the BTW live smoke\n',{flag:FAKE?'w':'wx'});
// PRIVATE no-retry launch override (owner: no automatic retry). Project settings merge over global for the host (trusted project), the native child (same cwd) and in-process BTW sessions (SettingsManager.create(cwd)). Global settings.json is never touched (hash-checked).
const PERSONAL_PKGS=FAKE?['https://github.com/fake/pkg-a','https://github.com/cartwmic/pi-btw']:(JSON.parse(fs.readFileSync(AG+'/settings.json','utf8')).packages||[]);
const PROJECT_SETTINGS={...RETRY_OVERRIDE_SETTINGS,...EXTENSION_ISOLATION_SETTINGS(PERSONAL_PKGS)};
fs.mkdirSync(PROJ+'/.pi',{recursive:true});
fs.writeFileSync(PROJ+'/.pi/settings.json',JSON.stringify(PROJECT_SETTINGS),{flag:FAKE?'w':'wx'});
assert(JSON.stringify(JSON.parse(fs.readFileSync(PROJ+'/.pi/settings.json','utf8')))===JSON.stringify(PROJECT_SETTINGS),'private project settings (no-retry + extension isolation) did not read back exactly');
const T=fs.mkdtempSync('/tmp/btw-smoke-'),SESS=T+'/sessions';fs.mkdirSync(SESS);
const WIRE=out+'/wire.jsonl';
const {default:pty}=await import(new URL('../../node_modules/node-pty/lib/index.js',import.meta.url).href);
const {Codec}=await import('./terminal-codec.mjs');
const env={PATH:NODE.replace(/\/node$/,'')+':/usr/bin:/bin',HOME:FAKE?T:os.homedir(),LANG:'en_US.UTF-8',TERM:'xterm-256color',PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_CODING_AGENT_SESSION_DIR:SESS,HINDSIGHT_AUTO_RECALL:'false',HINDSIGHT_AUTO_RETAIN:'false',
 SESSION_RECAP_PYTHON:'/usr/bin/false',   // TEST EXCLUSION: recap generation/widget/Herdr recap names excluded; not recap integration validation. Inherited by the BTW child.
 NODE_OPTIONS:'--import='+D+'/wire-observer.mjs',SMOKE_WIRE_LOG:WIRE,SMOKE_WIRE_CAP:String(CAP),
 ...(FAKE?{FAKE_BTW_NATIVE_DIR:AG+'/btw-native',FAKE_BASE:String(flags['fake-base']),FAKE_VARIANT:String(flags['fake-variant']||'normal'),FAKE_HELPER:String(flags['fake-pi'])}:{})};
const screen=new Codec(110,40);let exit,chain=Promise.resolve(),raw=fs.openSync(out+'/main.raw','wx'),rawBytes=0,failure;
const t0=Date.now(),HARD=FAKE?60000:300000;
const original=pty.spawn(FAKE?NODE:PI,FAKE?[PI,...HOST_EXT_ARGS]:[...HOST_EXT_ARGS,'--model','claude-compat/claude-sonnet-5-5','--thinking','low'],{cwd:PROJ,env,cols:110,rows:40,name:'xterm-256color'});
const exited=new Promise(r=>original.onExit(v=>{exit=v;r(v);}));
original.onData(d=>{chain=chain.then(async()=>{rawBytes+=Buffer.byteLength(d);assert(rawBytes<8e6,'raw cap');fs.writeSync(raw,d);await screen.write(d);for(const r of screen.replies.splice(0))if(!exit)original.write(r);}).catch(e=>{failure??=e;});});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),plain=()=>screen.plain(),send=s=>original.write(s),cmd=s=>send('\x1b[200~'+s+'\x1b[201~\r');
const wire=()=>{try{return fs.readFileSync(WIRE,'utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}};
const wireOther=()=>{try{return fs.readFileSync(WIRE+'.other','utf8').split('\n').filter(Boolean).map(JSON.parse);}catch{return[];}};
const nclaims=()=>wire().filter(r=>r.ev==='claim').length,nresp=()=>wire().filter(r=>r.ev==='response').length;
async function wait(pred,label,ms=90000){const s=Date.now();while(!pred()){if(failure)throw failure;if(exit)throw Error('pi exited before '+label);if(Date.now()-s>ms)throw Error('timeout '+label);if(Date.now()-t0>HARD)throw Error('hard time cap');const w=wire();if(w.some(r=>r.ev==='BLOCKED'))throw Error('request bound hit');if(w.some(r=>r.ev==='AUTH-TRAFFIC'))throw Error('OAuth traffic observed');await sleep(100);}await chain;fs.writeFileSync(out+'/'+label.replace(/\W+/g,'-')+'.pane',plain());}
const has=t=>plain().includes(t);
let result={status:'HOLD',mode:FAKE?'FAKE':'LIVE',scenario,allocation:ALLOC,cap:CAP,testExclusions:{recap:'SESSION_RECAP_PYTHON=/usr/bin/false: recap generation, widget and Herdr recap-name publishing are EXCLUDED; expected pane noise: "Recap operation failed; coverage unchanged." and Herdr "overview update failed; saved recaps remain available for recovery". Not recap integration validation; not validation of the recap memory fix.',notExcluded:'claude-compat-guard, ntfy and all other extensions/guards run unchanged; hindsight recall/retain disabled by environment only'}};
let analysis;
// Counts only (never content): assistant lines per owned btw-native session file. Taken at seed time and at the end, BEFORE owned cleanup, and persisted in result.json.
const snapBtw=()=>{const o={},root=AG+'/btw-native';if(!fs.existsSync(root))return o;for(const dn of fs.readdirSync(root).filter(x=>!before.btwDirs.includes(x)))for(const f of fs.readdirSync(root+'/'+dn,{recursive:true}))if(String(f).endsWith('.jsonl'))o[dn+'/'+f]=assistantLines(fs.readFileSync(root+'/'+dn+'/'+f,'utf8'));return o;};
let seedSnap;
try{
 await wait(()=>has('sonnet-5-5')||has('Sonnet'),'main-ready',60000);await sleep(1500);
 if(scenario==='summary'){
  cmd('Reply with the single word formed by joining M A I N and O K 1, no spaces or punctuation.');await wait(()=>has('MAINOK1')&&nresp()>=1,'main-answer');await sleep(1500);
  cmd('/btw');await sleep(FAKE?800:6000);
  seedSnap=snapBtw();
  send('Reply with the single word formed by joining S I D E and O K 1, no spaces or punctuation.');await sleep(400);send('\r');
  await wait(()=>has('SIDEOK1')&&nresp()>=2,'side-answer');await sleep(2000);
  send('\x1d');await sleep(FAKE?500:2500);
  cmd('/btw:summarize');await wait(()=>has('Here is a summary of a side conversation I had'),'summary-editor',90000);
  send('\x1b');await wait(()=>has('Handoff cancelled; nothing was sent.'),'summary-cancelled',20000);
 }else{
  cmd('/btw:ask Use the read tool on README.txt in the current directory, then reply with only the first word of that file in capital letters.');
  await wait(()=>has('SYNTHETIC')&&nresp()>=2,'ask-answer',120000);await sleep(1500);
 }
 await sleep(1500);send('\x1d');await sleep(1500);cmd('/quit');await sleep(FAKE?1500:6000);if(exit===undefined)cmd('/quit');
 await Promise.race([exited,sleep(FAKE?5000:30000)]);
 if(exit===undefined)throw Error('pi did not exit after /quit');
 analysis=analyze(scenario,wire());
 if(scenario==='summary'){ // cross-check with a seed baseline (contextual native child files inherit the main thread's assistant replies)
  const endSnap=snapBtw();const cc=childCrossCheck({seed:seedSnap,end:endSnap,wireChild:analysis.receipt.roles['btw-child']||0});
  analysis.receipt.childSession={seedAssistantLines:seedSnap??null,endAssistantLines:endSnap,assistantAddedAfterSeed:cc.side};
  analysis.failures.push(...cc.failures);analysis.ok=analysis.failures.length===0;
 }
 result={...result,status:analysis.ok?'COLLECTED':'HOLD',failures:analysis.failures,receipt:analysis.receipt};
}catch(e){failure??=e;const w=wire(),a=analyze(scenario,w);result={...result,status:'HOLD',failure:String(e).slice(0,300),failures:a.failures,receipt:a.receipt};try{fs.writeFileSync(out+'/failure-tail.pane',plain().slice(-2500));}catch{}}
finally{
 const wc=ms=>Promise.race([exited,sleep(ms)]);
 if(exit===undefined){try{send('\x03');}catch{}await wc(4000);}
 if(exit===undefined){try{original.kill('SIGTERM');}catch{}await wc(8000);}
 if(exit===undefined){try{original.kill('SIGKILL');}catch{}await wc(8000);}
 await chain;fs.fsyncSync(raw);fs.closeSync(raw);screen.dispose();
 const g=spawnSync('/bin/ps',['-axo','pid=,pgid=,command='],{encoding:'utf8'}).stdout.split('\n').filter(l=>l.trim().split(/\s+/)[1]===String(original.pid));
 const after={auth:sh(AG+'/auth.json'),trust:sh(AG+'/trust.json'),settings:sh(AG+'/settings.json'),lockLeft:fs.existsSync(AG+'/auth.json.lock')};
 result.retryOverride={file:'<project>/.pi/settings.json',settings:RETRY_OVERRIDE_SETTINGS};result.extensionIsolation={hostArgs:HOST_EXT_ARGS.map(a=>a.startsWith('/')?a.replace(AG,'~AGENT'):a),childPackageDelta:PROJECT_SETTINGS.packages.map(x=>x.source),limit:'child still loads auto-discovered ~/.pi/agent/extensions/*'};result.unchanged={auth:after.auth===before.auth,trust:after.trust===before.trust,settings:after.settings===before.settings,authLockLeft:after.lockLeft};
 result.exit=exit;result.groupLeft=g.map(l=>l.slice(0,100));result.elapsedMs=Date.now()-t0;result.otherHostsNotCounted=otherHosts(wireOther());
 const nd=(fs.existsSync(AG+'/btw-native')?fs.readdirSync(AG+'/btw-native'):[]).filter(d=>!before.btwDirs.includes(d));result.removedOwnedBtwDirs=nd;
 fs.writeFileSync(out+'/result.json',JSON.stringify(result,null,1));
 for(const d of nd)fs.rmSync(AG+'/btw-native/'+d,{recursive:true,force:true});
 fs.rmSync(T,{recursive:true,force:true});
 if(FAKE){fs.rmSync(PROJ,{recursive:true,force:true});fs.rmSync(AG,{recursive:true,force:true});}
 else if(PROJ.startsWith(TRUSTED_ROOT+'/_btw-live-smoke-'))fs.rmSync(PROJ,{recursive:true,force:true});
 console.log(JSON.stringify({status:result.status,mode:result.mode,scenario,failures:result.failures,totalClaims:result.receipt?.totalClaims,unchanged:result.unchanged,groupLeft:result.groupLeft}));
 process.exit(result.status==='COLLECTED'&&g.length===0&&result.unchanged.auth&&result.unchanged.trust&&result.unchanged.settings&&!result.unchanged.authLockLeft?0:1);
}
