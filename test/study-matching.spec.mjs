import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {runFixture,PROFILE,ROOT} from './portals/harness.mjs';
const dir=await mkdtemp(join(tmpdir(),'applifill-study205-'));let total=0;
const check=(name,got,want)=>{assert.deepEqual(got,want,name);total++;console.log('PASS '+name);};
const context=vm.createContext({console,setTimeout,clearTimeout,URL,location:{hostname:'example.test'},document:{querySelector:()=>null}});
vm.runInContext(await readFile(join(process.env.APPLI_FILL_EXT||join(ROOT,'extension'),'lib/matcher.js'),'utf8'),context);
const M=context.APPLI_FILL_MATCHER;
for(const[value,options,want]of [
 ['CSE',['Computer Science','Computer Science and Engineering','Mechanical Engineering'],'Computer Science and Engineering'],
 ['Computer Science and Engineering',['Mechanical Engineering','Computer Science','Business Administration'],'Computer Science'],
 ['Information Technology',['Computer Science','Information Systems','Mechanical Engineering'],'Information Systems'],
 ['ECE',['Mechanical Engineering','Electrical Engineering'],'Electrical Engineering'],
 ['Bachelor of Science in Computer Science',['Civil Engineering','Computer Science'],'Computer Science'],
 ['MBA',['Business Administration','Accounting'],'Business Administration'],
 ['Mechanical Engineering',['Computer Science','Electrical Engineering'],null],
 ['Engineering',['Civil Engineering','Chemical Engineering'],null],
 ]){
  const scored=options.map(option=>({option,score:M.studyChoiceScore(option,value)})).sort((a,b)=>b.score-a.score);
  check(value+' nearest offered subject',scored[0].score>=55?scored[0].option:null,want);
 }
const profile={...PROFILE,education:[{school:'Example University',degree:"Bachelor's Degree",fieldOfStudy:'CSE',endDate:'2021-06-01'}]};
try{
 for(const[url,name]of [['https://boards.greenhouse.io/acme/jobs/1','Greenhouse'],['https://jobs.lever.co/acme/1','Lever'],['https://careers-acme.icims.com/jobs/1/profile','iCIMS'],['https://acme.myworkdayjobs.com/en-US/jobs/1/apply','Workday'],['https://careers.example.test/apply','generic']]){
  for(const kind of ['native','custom']){
   const file=join(dir,name+'-'+kind+'.html');
   const input=kind==='native'?'<select id="major"><option value="">Select</option><option>Mechanical Engineering</option><option>Computer Science</option><option>Computer Science and Engineering</option></select>':'<button type="button" role="combobox" aria-haspopup="listbox" aria-controls="list" aria-expanded="false" aria-label="Dropdown" aria-describedby="question" id="major">Select</button><div id="list" role="listbox" hidden><div role="option">Mechanical Engineering</div><div role="option">Computer Science</div><div role="option">Business Administration</div></div>';
   await writeFile(file,`<!doctype html><title>Job application</title><style>body{font:16px sans-serif}button,select,[role=option]{padding:10px}</style><h1>Application</h1><form>${kind==='native'?'<label for="major">Major / Field of Study</label>':'<span id="question">Major / Field of Study</span>'}${input}</form><script>window.answer='';const el=document.getElementById('major');el.onchange=()=>window.answer=el.value;if(el.tagName==='BUTTON'){el.onclick=()=>{document.getElementById('list').hidden=false;el.setAttribute('aria-expanded','true')};document.querySelectorAll('[role=option]').forEach(o=>o.onclick=()=>{window.answer=o.textContent;el.textContent=o.textContent;el.setAttribute('aria-expanded','false');document.getElementById('list').hidden=true})}</script>`);
   const r=await runFixture(file,{profile,responses:[],url});
   try{if(process.env.ZDEBUG)console.log(JSON.stringify(await r.page.evaluate(()=>({fields:window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f=>({label:f.label,key:f.rule?.key,kind:f.kind,plan:window.__applifill.planField(f,window.__applifill.state.fillProfile,{})})),value:document.getElementById('major').textContent,run:window.__applifill.state.lastRun})),null,2));check(name+' '+kind+' selection committed',await r.page.evaluate(()=>window.answer),kind==='native'?'Computer Science and Engineering':'Computer Science');}finally{await r.browser.close();}
  }
 }
}finally{await rm(dir,{recursive:true,force:true});}
console.log(`${total}/${total} study matching checks passed`);
