import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {chromium} from 'playwright';
import {ROOT,PROFILE} from './portals/harness.mjs';
const require=createRequire(import.meta.url),ext=process.env.APPLI_FILL_EXT||join(ROOT,'extension');
function pkg(name){let p=dirname(require.resolve(name));while(!p.endsWith('node_modules/'+name)&&p!==dirname(p))p=dirname(p);return p;}
const vendors=await Promise.all([readFile(join(pkg('react'),'umd/react.development.js'),'utf8'),readFile(join(pkg('react-dom'),'umd/react-dom.development.js'),'utf8')]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
const profile={...PROFILE,workAuth:{...PROFILE.workAuth,authorizedToWork:'Yes',requireSponsorship:'No',previouslyEmployedHere:'No',willingToRelocate:'Yes',textMessageConsent:'No'}};
let total=0;const check=(name,value,want)=>{assert.deepEqual(value,want,name);total++;console.log('PASS '+name);};
try{
 for(const focused of [true,false]){
  const page=await browser.newPage();
  await page.addInitScript(profile=>{window.__APPLI_FILL_TEST=true;window.chrome={runtime:{lastError:null,onMessage:{addListener(){}},sendMessage(m,cb){setTimeout(()=>cb(m.type==='APPLI_FILL_GET_SESSION'?{ok:true,data:{profile,profiles:[profile],responses:[],premium:false,settings:{showOverlay:false,reuseSavedResponses:true,trackAutomatically:false}}}:m.type==='APPLI_FILL_CHECK'?{ok:true,data:{duplicate:false}}:{ok:true,data:{}}),0);}}};},profile);
  await page.route('**/*',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><div id="root"></div>'}));await page.goto('https://jobs.ashbyhq.com/acme/application');
  for(const source of vendors)await page.addScriptTag({content:source});
  await page.evaluate(()=>{
   const h=React.createElement;window.commits={};window.submitErrors=null;window.submits=0;window.buttonValueEvents=0;
   function Text({id,label,type='text'}){const[v,set]=React.useState('');return h('div',{className:'ashby-application-form-field-entry'},h('label',{htmlFor:id},label),h('input',{id,type,value:v,required:true,onChange:e=>set(e.target.value),onBlur:e=>window.commits[id]=e.target.value}));}
   function Choice({id,label,event,role}){const[visual,setVisual]=React.useState(null),pending=React.useRef(null);return h('div',{className:'ashby-application-form-field-entry','data-q':id},h('label',{className:'ashby-application-form-question-title',htmlFor:id},label),h('div',{role:'group',onBlur:()=>{if(pending.current!==null)window.commits[id]=pending.current;}},...['Yes','No'].map(answer=>h('button',{key:answer,type:'button',role:role||undefined,'aria-pressed':String(visual===answer),className:visual===answer?'active':'',
    [event]:()=>pending.current=answer,onClick:()=>{if(event==='onClick')pending.current=answer;setVisual(answer);}},answer)),h('input',{id,type:'checkbox',tabIndex:-1,'aria-hidden':'true',checked:visual==='Yes',readOnly:true,style:{position:'absolute',width:0,height:0,opacity:0}})));}
   function Native(){const[v,set]=React.useState('');return h('fieldset',null,h('legend',null,'Is it OK for us to send you text messages?'),...['Yes','No'].map(value=>h('label',{key:value},h('input',{type:'radio',name:'sms',value,checked:v===value,required:true,onChange:()=>{set(value);window.commits.sms=value;}}),value)));}
   function App(){return h('form',{className:'ashby-application-form',noValidate:true,onInput:e=>{if(e.target.tagName==='BUTTON')window.buttonValueEvents++;},onChange:e=>{if(e.target.tagName==='BUTTON'){window.buttonValueEvents++;const id=e.target.closest('[data-q]')?.dataset.q;if(id)window.commits[id]=null;}},onSubmit:e=>{e.preventDefault();window.submits++;window.submitErrors=['name','email','phone','auth','sponsor','prior','relocate','sms'].filter(key=>window.commits[key]===undefined||window.commits[key]===null||window.commits[key]==='');}},h('h1',null,'Acme application'),h(Text,{id:'name',label:'Full Name'}),h(Text,{id:'email',label:'Email',type:'email'}),h(Text,{id:'phone',label:'Phone',type:'tel'}),h(Choice,{id:'auth',label:'Are you authorized to work lawfully in the United States?',event:'onPointerDown'}),h(Choice,{id:'sponsor',label:'Will you now or in the future require sponsorship in order to work lawfully in the United States?',event:'onMouseDown'}),h(Choice,{id:'prior',label:'Have you previously been employed by Acme?',event:'onClick'}),h(Choice,{id:'relocate',label:'Are you willing to relocate?',event:'onPointerDown',role:'radio'}),h(Native),h('button',{type:'submit'},'Submit Application'));}
   ReactDOM.createRoot(document.getElementById('root')).render(h(App));
  });
  await page.addStyleTag({content:'body{font:16px sans-serif}label{display:block}input,button{padding:10px;margin:5px}.active{background:black;color:white}fieldset,form>div{margin:15px}'});
  await page.getByRole('button',{name:'Submit Application',exact:true}).waitFor();
  if(!focused)await page.evaluate(()=>Object.defineProperty(document,'hasFocus',{value:()=>false,configurable:true}));
  for(const file of ['lib/field-map.js','lib/matcher.js','lib/ats.js','content/autofill.js'])await page.addScriptTag({content:await readFile(join(ext,file),'utf8')});
  await page.evaluate(()=>window.__applifill.run({manual:true}));
  const data=await page.evaluate(()=>({commits:window.commits,submits:window.submits,buttonEvents:window.buttonValueEvents}));
  const label=focused?'focused':'popup focus';
  for(const[key,want]of Object.entries({auth:'Yes',sponsor:'No',prior:'No',relocate:'Yes',sms:'No'}))check(label+' '+key+' committed',data.commits[key],want);
  check(label+' name committed',data.commits.name,profile.personal.firstName+' '+profile.personal.lastName);
  check(label+' email committed',data.commits.email,profile.personal.email);
  check(label+' no fake button value events',data.buttonEvents,0);
  check(label+' no automatic submit',data.submits,0);
  await page.getByRole('button',{name:'Submit Application',exact:true}).click();
  check(label+' submit validation',await page.evaluate(()=>window.submitErrors),[]);
  const sponsor=page.locator('[data-q=sponsor] button').filter({hasText:/^Yes$/});await sponsor.click();await page.locator('#name').click();
  await page.evaluate(()=>window.__applifill.run({manual:true}));
  check(label+' manual choice preserved',await page.evaluate(()=>window.commits.sponsor),'Yes');
  await page.close();
 }
}finally{await browser.close();}
console.log(`${total}/${total} Ashby submission-state checks passed`);
