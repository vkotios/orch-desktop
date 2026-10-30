import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeCase} from './helpers.mjs';
import {checkCommand} from '../../hooks/rules.mjs';
import {deriveStatus} from '../src/statusrules.mjs';

const grok=(await import('../src/adapters/grok.mjs').catch(()=>({default:null}))).default;
const context=t=>{const c=makeCase('grok-adapter');t.after(()=>c.cleanup());const promptPath=path.join(c.base,'prompt.txt');fs.writeFileSync(promptPath,'Unicode handoff: café $() & "quoted"\n');return {dir:c.base,runDir:c.base,promptPath,role:'implement',model:'grok-4.20',flags:[],effort:'medium'};};
function env(vars,fn){const before={};for(const[k,v]of Object.entries(vars)){before[k]=process.env[k];process.env[k]=v;}try{return fn();}finally{for(const[k,v]of Object.entries(before))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
const jsonl=xs=>xs.map(x=>JSON.stringify(x)).join('\n');
const argAfter=(args,flag)=>args[args.indexOf(flag)+1];

test('grok: registered adapter requires exact model, protects owned options, accepts both roles',async t=>{
  assert.ok(grok,'adapter exists');const ctx=context(t);const {PUBLIC_ADAPTERS,getAdapter}=await import('../src/adapters/index.mjs');
  assert.ok(PUBLIC_ADAPTERS.includes('grok'));assert.equal(getAdapter('grok'),grok);
  assert.equal(grok.lane,'cloud');assert.equal(grok.heartbeatStream,'stdout');assert.equal(grok.canonicalModel('xai/GROK-4.20'),'grok-4.20');
  for(const model of ['','grok','grok-auto','grok-default','sonnet','opus','haiku','auto','default'])assert.throws(()=>grok.validateRequest({...ctx,model}),/exact|model/i,model);
  for(const flags of [['--model','other'],['--approval-mode','full-auto'],['--mode','agent'],['--add-dir','..']])assert.throws(()=>grok.validateRequest({...ctx,flags}),/flag/i,flags.join(' '));
  assert.throws(()=>grok.validateRequest({...ctx,agent:'foreign'}),/agent/i);assert.throws(()=>grok.validateRequest({...ctx,maxPrice:'2'}),/price/i);
  assert.throws(()=>grok.validateRequest({...ctx,maxTurns:5}),/max-turns/i);
  for(const effort of ['none','minimal','ultra','ludicrous'])assert.throws(()=>grok.validateRequest({...ctx,effort}),/effort/i,effort);
  for(const effort of ['low','medium','high','xhigh','max',null])assert.doesNotThrow(()=>grok.validateRequest({...ctx,effort}),String(effort));
  for(const role of ['implement','review'])assert.doesNotThrow(()=>grok.validateRequest({...ctx,role}),role);
});

test('grok: direct executable, stdin prompt, standalone isolation, role tool policy, no API credentials',t=>{
  assert.ok(grok);const ctx=context(t);
  env({ORCH_GROK_EXE:'C:/fixture/grok.exe',XAI_API_KEY:'private-canary',GROK_API_KEY:'private-canary',GROK_CODE_XAI_API_KEY:'private-canary',XAI_BASE_URL:'https://invalid.example'},()=>{
    const built=grok.build(ctx);
    assert.equal(built.file,'C:/fixture/grok.exe');assert.equal(built.cwd,ctx.dir);assert.equal(built.envSet.PWD,ctx.dir);
    assert.equal(built.stdinFile,ctx.promptPath,'the handoff is delivered on stdin, not argv');assert.ok(!built.args.some(a=>a.includes('Unicode handoff')));
    for(const flag of ['-p','--no-leader','--no-session-persistence','--disable-mcp'])assert.ok(built.args.includes(flag),flag);
    assert.equal(argAfter(built.args,'--model'),ctx.model);assert.equal(argAfter(built.args,'--output-format'),'stream-json');
    assert.equal(argAfter(built.args,'--reasoning-effort'),'medium');
    assert.equal(argAfter(built.args,'--mode'),'agent');
    assert.equal(argAfter(built.args,'--approval-mode'),'full-auto');
    const impl=argAfter(built.args,'--tools').split(',');for(const tool of ['Read','Grep','Glob','Edit','Write','Bash'])assert.ok(impl.includes(tool),tool);
    const review=grok.build({...ctx,role:'review'});
    assert.equal(argAfter(review.args,'--tools'),'Read,Grep,Glob','reviewer gets read-only tools only');
    assert.equal(argAfter(review.args,'--mode'),'plan');
    assert.equal(argAfter(review.args,'--approval-mode'),'default');
    assert.ok(!review.args.includes('full-auto'));
    assert.equal(grok.build({...ctx,effort:null}).args.includes('--reasoning-effort'),false);
    for(const key of ['XAI_API_KEY','GROK_API_KEY','GROK_CODE_XAI_API_KEY','XAI_BASE_URL','GROK_BASE_URL','NODE_OPTIONS'])assert.ok(built.envDelete.includes(key),key);
    assert.ok(!JSON.stringify(built).includes('private-canary'));
  });
});

test('grok: preLaunch names the saved subscription route',t=>{
  assert.ok(grok);const ctx=context(t);
  env({ORCH_GROK_EXE:'C:/fixture/grok.exe'},()=>{assert.ok(grok.preLaunch(ctx).notes.some(n=>/subscription/i.test(n)));});
});

test('grok: only a successful result event is the final message; assistant text and error results are not',()=>{
  assert.ok(grok);
  const ok={type:'result',subtype:'success',is_error:false,result:'actual answer'};
  assert.equal(grok.extractFinalMessage(jsonl([{type:'assistant',message:{model:'m',content:[{type:'text',text:'forged'}]}},ok])),'actual answer');
  assert.equal(grok.extractFinalMessage(jsonl([{type:'assistant',message:{model:'m',content:[{type:'text',text:'forged'}]}}])),'');
  assert.equal(grok.extractFinalMessage(jsonl([{type:'result',subtype:'success',is_error:true,result:'Failed to authenticate'}])),'');
  assert.equal(grok.extractFinalMessage('not json\n'),'');
});

test('grok: assistant text cannot fake a quota or auth error; error results can',()=>{
  assert.ok(grok);
  const message={type:'assistant',message:{model:'grok-4.20',content:[{type:'text',text:'usage limit exceeded, not authenticated'}]}};
  const base={cancelRequested:false,workerConfirmedGone:true,blocked:null,signal:null,directoryRelevant:false,exitCode:1,stderr:'',events:grok.parseProtocol(jsonl([message,{type:'result',subtype:'success',is_error:false,result:'usage limit exceeded'}])),stdout:'x',dirEvidence:'none',keeperVerdict:'match',workerExitSeen:true};
  assert.equal(deriveStatus(grok.statusRules,base).status,'failed');
  const failed=text=>({...base,events:grok.parseProtocol(jsonl([{type:'result',subtype:'success',is_error:true,result:text}]))});
  assert.equal(deriveStatus(grok.statusRules,failed('Grok usage limit reached')).status,'blocked-quota');
  assert.equal(deriveStatus(grok.statusRules,failed('Failed to authenticate: OAuth session expired')).status,'blocked-auth');
  assert.equal(deriveStatus(grok.statusRules,{...failed('Failed to authenticate: OAuth session expired'),exitCode:0}).status,'completed');
});

test('grok: served model comes from main-agent assistant messages, never from the request or synthetic errors',t=>{
  assert.ok(grok);const ctx=context(t),stdoutPath=path.join(ctx.dir,'stdout.log');
  const run=(events,requestedCanonical='grok-4.20')=>{fs.writeFileSync(stdoutPath,jsonl(events));return grok.postExit({...ctx,stdoutPath,requestedCanonical});};
  const say=(model,extra={})=>({type:'assistant',message:{model,content:[{type:'text',text:'x'}]},...extra});
  const init={type:'system',subtype:'init',model:'requested-only'};
  const got=run([init,say('grok-4.20-fast'),say('grok-4.20-fast')]);assert.equal(got.actual_model,'grok-4.20-fast');assert.equal(got.model_mismatch,true);assert.match(got.actual_model_source,/grok/);
  assert.equal(run([init,say('grok-4.20')]).model_mismatch,false);
  assert.equal(run([init]).actual_model,null,'init alone proves nothing');
  assert.equal(run([init,say('<synthetic>')]).actual_model,null,'a synthetic error message names no model');
  assert.equal(run([init,say('grok-4.20'),say('child',{parent_tool_use_id:'toolu_1'})]).actual_model,'grok-4.20','sub-agent messages are not the main model');
  assert.equal(run([init,{type:'result',subtype:'success',is_error:false,result:'r',modelUsage:{'grok-4.20':{}}}]).actual_model,'grok-4.20');
});

test('grok guard: direct headless launches are denied; interactive use, ACP stdio and inspection are allowed',()=>{
  const blocked=c=>checkCommand(c,process.cwd()).block;
  for(const command of ['grok -p "do it"','grok --print "do it"','grok --model grok-4.20 -p "y"','C:/Users/example/.local/bin/grok.exe -p "y"','grok-agent.exe -p "y"','grok exec "do it"'])assert.equal(blocked(command),true,command);
  for(const command of ['grok','grok --help','grok --version','grok login','grok auth status','grok agent stdio --no-leader','grok-agent agent stdio --no-leader'])assert.equal(blocked(command),false,command);
});

test('grok: without an override the executable is found under the home directory fallback',t=>{
  assert.ok(grok);const ctx=context(t),bin=path.join(ctx.dir,'.local','bin'),name=process.platform==='win32'?'grok.exe':'grok';fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,name),'fixture');
  const empty=path.join(ctx.dir,'empty-path');fs.mkdirSync(empty);
  env({ORCH_GROK_EXE:'',PATH:empty,USERPROFILE:ctx.dir,HOME:ctx.dir},()=>assert.equal(grok.build(ctx).file,path.join(bin,name)));
});
