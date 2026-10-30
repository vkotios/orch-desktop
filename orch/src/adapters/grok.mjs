// Grok Build / Grok CLI headless print mode (`grok -p`, stream-json). Lets any controller
// launch Grok as an implementer or a read-only reviewer using the saved Grok subscription login.
//
//  - Prompt: `-p` reads the handoff from STDIN (`stdinFile`), so nothing of it lands on argv.
//  - Isolation: `--no-leader` runs standalone without attaching to a background session leader;
//    `--no-session-persistence` avoids polluting interactive session history; `--disable-mcp`
//    prevents foreign MCP servers from running inside a delegated worker/reviewer slice.
//  - Roles: an implementer gets `Read,Grep,Glob,Edit,Write,Bash` under `--mode agent` and
//    `--approval-mode full-auto` (print mode cannot answer interactive permission prompts, and
//    the run is confined to its own worktree by orch). A reviewer gets `Read,Grep,Glob` only
//    under `--mode plan` (`--approval-mode default`): write and shell tools are excluded.
//  - Billing: subscription login only. XAI_*, GROK_API_* and GROK_CODE_XAI_* variables are
//    stripped from the child environment so a stray key cannot switch the run to API billing.
//  - Model used: extracted from the main agent's assistant messages (`e.type === 'assistant'`
//    without `parent_tool_use_id`), falling back to `result.modelUsage` when a single model is
//    listed. The `init` event and the requested model are never treated as proof.
import os from 'node:os';
import path from 'node:path';
import {resolveCliExe,whereAll} from '../exe.mjs';
import {canonicalId,assertModelPermitted} from '../models.mjs';
import {OrchError} from '../errors.mjs';
import {protocolErrorText} from '../statusrules.mjs';
import {validateRequest as validateCommon,readBounded,parseJsonl,modelResult,deletedEnvironment,subscriptionStatusRules,validateNativeArgv} from './subscription-cli.mjs';

const grokStatusRules=[
  {name:'grok-quota',test:o=>o.exitCode!==0&&/usage limit (?:reached|exceeded)|hit your (?:\w+ )?limit|limit reached|grok quota exceeded|rate limit exceeded/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-quota',reason:'provider-quota'},
  {name:'grok-auth',test:o=>o.exitCode!==0&&/failed to authenticate|oauth (?:session|token) (?:expired|revoked)|not logged in|please run (?:\/login|grok login)|invalid api key|grok subscription required/i.test(o.stderr+'\n'+protocolErrorText(o.events)),status:'blocked-auth',reason:'provider-auth'},
];

export const ALLOWED_EFFORTS=['low','medium','high','xhigh','max'];
const IMPLEMENT_TOOLS='Read,Grep,Glob,Edit,Write,Bash';
const REVIEW_TOOLS='Read,Grep,Glob';
const FORBIDDEN_ALIASES=['grok','grok-auto','grok-default'];

export function grokFallbacks(env=process.env){
  const ext=process.platform==='win32'?'.exe':'';
  const home=env.USERPROFILE||env.HOME||os.homedir();
  const localAppData=env.LOCALAPPDATA||path.join(home,'AppData','Local');
  const fromPath=whereAll(`grok-agent${ext}`,env).filter(p=>process.platform!=='win32'||/\.exe$/i.test(p));
  return [
    ...fromPath,
    path.join(home,'.local','bin',`grok${ext}`),
    path.join(home,'.local','bin',`grok-agent${ext}`),
    path.join(home,'.cargo','bin',`grok${ext}`),
    path.join(home,'.cargo','bin',`grok-agent${ext}`),
    ...(process.platform==='win32'?[
      path.join(localAppData,'Programs','grok','grok.exe'),
      path.join(localAppData,'grok','grok.exe'),
    ]:[]),
  ];
}

export function resolveGrokExe(){
  return resolveCliExe('grok',{fallbacks:grokFallbacks});
}

function validateRequest(ctx){
  validateCommon({...ctx,effort:null});
  if(FORBIDDEN_ALIASES.includes(canonicalId(ctx.model)))throw new OrchError('An exact model selector is required; automatic/family aliases are not supported','bad-model');
  if(ctx.effort!=null&&!ALLOWED_EFFORTS.includes(ctx.effort))throw new OrchError(`Invalid reasoning effort for Grok (supported: ${ALLOWED_EFFORTS.join(', ')})`,'bad-effort');
  if(ctx.maxTurns!=null)throw new OrchError('--max-turns is not supported by the Grok adapter','unsupported-limit');
}

/** The served model id without a context-window suffix such as `[1m]`, lower-cased. */
const servedId=m=>{const id=canonicalId(String(m??'').replace(/\[[^\]]*\]$/,''));return id&&id!=='<synthetic>'?id:null;};
const isError=e=>(e.type==='result'&&e.is_error===true)||e.type==='error';

export default {
  name:'grok',lane:'cloud',needsModel:true,heartbeatStream:'stdout',directoryEvidence:false,
  canonicalModel:canonicalId,validateRequest,
  preLaunch(ctx){
    validateRequest(ctx);assertModelPermitted(ctx.model,!!ctx.ownerApprovedModel);
    this.build({...ctx,promptPath:ctx.launchPromptPath||ctx.promptPath});
    return {notes:['Saved subscription login; no automatic API fallback (XAI_* and GROK_API_* variables are stripped)'],extra:{}};
  },
  build(ctx){
    validateRequest(ctx);
    const review=ctx.role==='review';
    const args=['-p','--model',ctx.model,...(ctx.effort?['--reasoning-effort',ctx.effort]:[]),'--output-format','stream-json','--no-leader','--no-session-persistence','--disable-mcp','--tools',review?REVIEW_TOOLS:IMPLEMENT_TOOLS,'--mode',review?'plan':'agent','--approval-mode',review?'default':'full-auto'];
    const file=resolveGrokExe();validateNativeArgv(file,args);
    return {
      file,args,cwd:ctx.dir,envSet:{PWD:ctx.dir},
      envDelete:deletedEnvironment(['XAI_','GROK_API_','GROK_CODE_XAI_'],['XAI_API_KEY','GROK_API_KEY','GROK_CODE_XAI_API_KEY','XAI_BASE_URL','GROK_BASE_URL','NODE_OPTIONS']),
      stdinFile:ctx.promptPath,
      notes:['Direct native Grok executable; handoff on stdin, nothing of it on argv','Standalone session (--no-leader, --no-session-persistence, --disable-mcp); saved subscription login only',review?'Reviewer tools: Read, Grep, Glob only under plan mode (a tool restriction, not an OS sandbox)':'Implementer tools: Read, Grep, Glob, Edit, Write, Bash under full-auto in the run worktree'],
    };
  },
  parseProtocol(stdout){
    return parseJsonl(stdout).map(e=>isError(e)?{type:'error',message:String(e.result??e.message??e.error?.message??''),native:e}:{type:'native-event',native:e});
  },
  extractFinalMessage(stdout){
    const results=parseJsonl(stdout).filter(e=>e.type==='result'&&e.is_error!==true&&typeof e.result==='string');
    return results.at(-1)?.result.trim()||'';
  },
  postExit(ctx){
    const events=parseJsonl(readBounded(ctx.stdoutPath));
    const served=[...new Set(events.filter(e=>e.type==='assistant'&&!e.parent_tool_use_id).map(e=>servedId(e.message?.model??e.model)).filter(Boolean))];
    let models=served,source='grok-assistant-message';
    if(!models.length){
      const usage=events.filter(e=>e.type==='result'&&e.modelUsage&&typeof e.modelUsage==='object').at(-1)?.modelUsage;
      const keys=usage?[...new Set(Object.keys(usage).map(servedId).filter(Boolean))]:[];
      if(keys.length===1){models=keys;source='grok-result-model-usage';}
    }
    return modelResult(models,servedId(ctx.requestedCanonical),source);
  },
  statusRules:[...subscriptionStatusRules,...grokStatusRules],
};
