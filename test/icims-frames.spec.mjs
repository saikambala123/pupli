/** Actual Chromium documents on different origins, using the real background
 * frame dispatcher and content-script runtime listeners. No live requests. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {ROOT,PROFILE} from './portals/harness.mjs';
const ext=process.env.APPLI_FILL_EXT||join(ROOT,'extension');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
let count=0;
const check=(name,got,want)=>{assert.deepEqual(got,want,name);count++;console.log('PASS '+name);};
try{
 const page=await browser.newPage();
 const frameIds=new Map();let nextId=0;
 const idFor=f=>{if(!frameIds.has(f))frameIds.set(f,nextId++);return frameIds.get(f);};
 const callFrame=(frame,message)=>frame.evaluate(msg=>new Promise(resolve=>{
  const listener=window.__listeners?.[0];if(!listener)return resolve(null);
  const pending=listener(msg,{},resolve);if(pending===false)resolve(null);
 }),message);
 let workerListener;
 let probeGate=null;
 const chrome={
  storage:{local:{get(_keys,cb){cb({});},set(_v,cb){cb?.();},remove(_v,cb){cb?.();}}},
  runtime:{lastError:null,onMessage:{addListener(fn){workerListener=fn;}},onInstalled:{addListener(){}},onStartup:{addListener(){}}},
  action:{setBadgeText(){},setBadgeBackgroundColor(){}},commands:{onCommand:{addListener(){}}},
  tabs:{create(){},query:async()=>[{id:1}],onActivated:{addListener(){}},sendMessage(_id,msg,options,cb){
   if(typeof options==='function'){cb=options;options=null;}
   const frames=page.frames().filter(f=>options? idFor(f)===options.frameId:true);
   Promise.all(frames.map(f=>callFrame(f,msg))).then(rs=>cb?.(rs.find(Boolean)),()=>cb?.());
  }},
  scripting:{executeScript:async()=>{if(probeGate)await probeGate;return Promise.all(page.frames().map(async frame=>({frameId:idFor(frame),result:await frame.evaluate(()=>({url:location.href,visible:document.visibilityState!=='hidden'}))})));}},
 };
 const context=vm.createContext({chrome,console,fetch:async()=>{throw new Error('Unexpected network request');},setTimeout,clearTimeout,setInterval,clearInterval,Date,URL,JSON,Math,Promise,AbortController,Object,Array,Set,Map,String,Number,Boolean,Error});
 vm.runInContext(await readFile(join(ext,'background.js'),'utf8'),context);
 await page.exposeBinding('workerMessage',({frame},msg)=>new Promise(resolve=>workerListener(msg,{tab:{id:1},frameId:idFor(frame)},resolve)));
 await page.addInitScript(profile=>{
  window.__APPLI_FILL_TEST=true;window.__listeners=[];
  window.chrome={runtime:{lastError:null,onMessage:{addListener(fn){window.__listeners.push(fn);}},sendMessage(msg,cb){
   if(msg.type==='APPLI_FILL_FILL_TAB'||msg.type==='APPLI_FILL_STOP')return window.workerMessage(msg).then(cb);
   const reply=msg.type==='APPLI_FILL_GET_SESSION'?{ok:true,data:{profile,profiles:[profile],responses:[],premium:false,settings:{showOverlay:false,reuseSavedResponses:true,trackAutomatically:false,fillDelayMs:0}}}:msg.type==='APPLI_FILL_CHECK'?{ok:true,data:{duplicate:false}}:{ok:true,data:{}};
   setTimeout(()=>cb?.(reply),0);
  }}};
 },PROFILE);
 const nested='<html><body><h2>PERSONAL</h2><form><table><tr><td>Last Name:</td><td>First Name:</td><td>Middle:</td></tr><tr><td><input id="last"></td><td><input id="first"></td><td><input id="middle"></td></tr></table></form></body></html>';
 await page.route('**/*',route=>{
  const url=route.request().url();let body;
  if(url.includes('careers.example.test'))body='<h1>Careers</h1><iframe id="app" src="https://careers-discounttire.icims.com/jobs/1/profile"></iframe><iframe src="https://ads.example.test/apply"></iframe>';
  else if(url.includes('icims.com'))body=`<h1>Apply</h1><form><label for="city">City</label><input id="city"><label for="zip">Zip</label><input id="zip"><label for="street">Address</label><input id="street"></form><iframe id="iform"></iframe><script>document.getElementById('iform').srcdoc=${JSON.stringify(nested)};</script>`;
  else body='<h1>Application</h1><form><label for="ad-first">First Name</label><input id="ad-first"><input><input></form>';
  route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html><head><style>iframe{width:900px;height:350px}input{padding:6px}td{padding:8px}</style></head><body>'+body+'</body></html>'});
 });
 await page.goto('https://careers.example.test/jobs/1');await page.waitForFunction(()=>document.getElementById('app').contentWindow!==null);
 await page.waitForTimeout(150);
 page.frames().forEach(idFor);
 for(const frame of page.frames())for(const file of ['lib/field-map.js','lib/matcher.js','lib/ats.js','content/autofill.js'])await frame.addScriptTag({content:await readFile(join(ext,file),'utf8')});
 const app=page.frames().find(f=>f.url().includes('icims.com'));
 const blank=page.frames().find(f=>f.url()==='about:srcdoc');
 const ad=page.frames().find(f=>f.url().includes('ads.example.test'));
 check('cross-origin frame exists',Boolean(app),true);check('nested srcdoc frame exists',Boolean(blank),true);
 await app.evaluate(()=>window.postMessage({source:'applifill',type:'APPLI_FILL_RUN'},'*'));await page.waitForTimeout(100);
 check('page postMessage cannot trigger a fill',await app.locator('#city').inputValue(),'');
 const result=await callFrame(page.mainFrame(),{type:'APPLI_FILL_RUN'});
 check('toolbar operation succeeds',result.ok,true);
 check('cross-origin city',await app.locator('#city').inputValue(),PROFILE.personal.city);
 check('cross-origin ZIP',await app.locator('#zip').inputValue(),PROFILE.personal.zip);
 check('cross-origin street',await app.locator('#street').inputValue(),PROFILE.personal.address+', '+PROFILE.personal.addressLine2);
 if(process.env.ZDEBUG)console.log(JSON.stringify(await blank.evaluate(()=>({url:location.href,referrer:document.referrer,icims:window.APPLI_FILL_FIELD_MAP.helpers.onIcimsPage(),state:{runId:window.__applifill.state.runId,lastRun:window.__applifill.state.lastRun},fields:window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f=>({id:f.el.id,label:f.label,rule:f.rule?.key}))})),null,2));
 check('nested iForm first name',await blank.locator('#first').inputValue(),PROFILE.personal.firstName);
 check('nested iForm surname',await blank.locator('#last').inputValue(),PROFILE.personal.lastName);
 check('nested iForm middle',await blank.locator('#middle').inputValue(),PROFILE.personal.middleName);
 check('unrelated third-party form untouched',await ad.locator('#ad-first').inputValue(),'');
 check('aggregate filled count includes both frames',result.data.filled>=6,true);
 check('one fill run per application frame',await app.evaluate(()=>window.__applifill.state.runId),1);
 check('one fill run per nested frame',await blank.evaluate(()=>window.__applifill.state.runId),1);
 await app.locator('#city').fill('Manual city');await app.locator('#city').blur();await callFrame(page.mainFrame(),{type:'APPLI_FILL_RUN'});
 check('manual edit in child frame preserved',await app.locator('#city').inputValue(),'Manual city');
 const stopped=await page.evaluate(()=>window.workerMessage({type:'APPLI_FILL_STOP'}));
 await page.waitForTimeout(50);check('stop returns success',stopped.ok,true);
 check('stop reaches child frame',await app.evaluate(()=>window.__applifill.state.stopRequested),true);
 check('stop reaches nested frame',await blank.evaluate(()=>window.__applifill.state.stopRequested),true);
 let releaseProbe;probeGate=new Promise(resolve=>releaseProbe=resolve);
 const before=await app.evaluate(()=>window.__applifill.state.runId);
 const nestedBefore=await blank.evaluate(()=>window.__applifill.state.runId);
 const pending=callFrame(page.mainFrame(),{type:'APPLI_FILL_RUN'});
 const until=Date.now()+1000;while(!vm.runInContext('activeFillTabs.has(1)',context)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,5));
 const duplicate=await new Promise(resolve=>workerListener({type:'APPLI_FILL_FILL_TAB'},{tab:{id:1},frameId:0},resolve));
 check('concurrent click is rejected',duplicate.error,'Already filling.');
 await new Promise(resolve=>workerListener({type:'APPLI_FILL_STOP'},{tab:{id:1},frameId:0},resolve));
 probeGate=null;releaseProbe();
 const cancelled=await pending;
 check('stop during frame discovery cancels operation',cancelled.data.stopped,true);
 check('stop prevents a queued application frame starting',await app.evaluate(()=>window.__applifill.state.runId),before);
 check('stop prevents a queued nested frame starting',await blank.evaluate(()=>window.__applifill.state.runId),nestedBefore);
 const restarted=await callFrame(page.mainFrame(),{type:'APPLI_FILL_RUN'});
 check('a new explicit click works after stop',restarted.ok,true);

}finally{await browser.close();}
console.log(`${count}/${count} iCIMS frame checks passed`);
