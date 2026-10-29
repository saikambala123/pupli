/** Screenshot regressions: full registration/application form, declarations,
 * N/A instructions and a real asynchronous privacy dialog. Runs offline Chromium. */
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runFixture, PROFILE} from './portals/harness.mjs';
const dir=await mkdtemp(join(tmpdir(),'applifill-registration-'));
const field=(id,label,type='text',extra='')=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" ${extra}></div>`;
const select=(id,label,options)=>`<div class="field"><label for="${id}">${label}</label><select id="${id}"><option value="-1">No Selection</option>${options.map(o=>`<option>${o}</option>`).join('')}</select></div>`;
const question="Do you have a minimum education level of high school diploma or GED?";
const alias="List any aliases or other name(s) you have used or currently use or indicate N/A";
const sponsorship='Will you now or in the future require McDonald’s to commence (“sponsor”) an immigration case in order to employ you (for example, H-1B or other employment-based immigration case)? This is sometimes called “sponsorship” for an employment-based visa status.';
const body=`${field('email','Email Address','email')}${field('email2','Retype Email Address','email')}${field('pw','Choose Password','text')}${field('pw2','Retype Password','password')}
${field('first','First Name')}${field('last','Last Name')}
${select('country','Country',['India','United States'])}${select('state','State/Province',['Texas','North Carolina'])}${field('city','City')}${field('zip','Zip/Postal Code')}
${select('authorized','Are you legally authorized to work in the United States?',['Yes','No'])}${select('sponsor',sponsorship,['Yes','No'])}
${select('diploma',question,['Yes','No'])}${select('relatives',"Does your spouse or any immediate family member(s) currently work for McDonald's?",['Yes','No'])}
${field('salary','What is your salary expectation?')}${select('ethnicity','Ethnicity',['Hispanic or Latino','Not Hispanic or Latino'])}${select('race','Race',['Asian','White','Black or African American'])}
<fieldset><legend>Gender</legend><label><input id="noGender" name="gender" type="radio" value="No Selection" checked>No Selection</label><label><input id="female" name="gender" type="radio" value="Female">Female</label><label><input id="male" name="gender" type="radio" value="Male">Male</label></fieldset>
${select('veteran','Veteran Self-Identification Status',['I am not a protected veteran','I identify as one or more of the classifications of a protected veteran'])}${select('genderIdentity','Gender Identity',['Man','Woman','Non-binary','Prefer not to say'])}${select('orientation','Sexual Orientation',['Heterosexual','Bisexual','Prefer not to say'])}
${select('language','Preferred Language',['English','Hindi'])}${select('residence','Country/Region of Residence:',['India','United States'])}
<fieldset><legend>Make My Profile Visible to:</legend>${['Any company recruiter worldwide','Any company recruiter in my country/region of residence','Only recruiters managing jobs I apply to'].map((s,i)=>`<label><input id="visibility${i}" type="radio" name="visibility" value="${s}">${s}</label>`).join('')}</fieldset>
${field('alerts','Receive new job posting notifications','checkbox')}${field('aliases',alias)}
${field('unknown','List professional registrations or indicate N/A')}${field('withoutInstruction','List an unknown professional registration')}${field('forbidden','List certifications; do not indicate N/A')}${field('number','Enter N/A if unknown','number')}${field('date','Enter N/A if unknown','date')}
${select('naSelect','Select an award or indicate N/A',['N/A','Award A'])}${field('helpNA','List other credentials','text','aria-describedby="helpText"')}<p id="helpText">Enter N/A if unknown</p>
${field('terms','I agree to the terms of use','checkbox')}${field('marketing','I agree to the privacy policy and marketing offers','checkbox')}
<a id="policy" href="/privacy">Read and accept the data privacy statement.</a><button id="apply" type="submit">Apply</button>
<div id="privacy" role="dialog" aria-modal="true" hidden><h2>Data Privacy Statement</h2><p>Application data privacy statement.</p><button id="accept" type="button">Accept</button><button id="decline" type="button">Decline</button><button id="print" type="button">Print</button></div>
<div role="dialog" id="cookie"><h2>Cookie settings</h2><p>Read our privacy policy before accepting cookies.</p><button type="button" id="cookieAccept">Accept</button></div>`;
const html=`<!doctype html><html><head><title>Create Account - Career Application</title><style>body{font:16px sans-serif;margin:25px}.field,fieldset{margin:10px}label{display:block}input,select,button{padding:6px}#privacy:not([hidden]){position:fixed;inset:15%;background:white;border:2px solid #111;padding:20px}#cookie{position:fixed;right:0;top:0;background:#ddd}</style></head><body><h1>Create Account</h1><form>${body}</form><script>window.model={};window.accepts=0;window.submits=0;window.cookies=0;window.declines=0;window.prints=0;document.addEventListener('change',e=>{window.model[e.target.id]=e.target.type==='checkbox'?e.target.checked:e.target.value});document.getElementById('policy').onclick=e=>{e.preventDefault();setTimeout(()=>document.getElementById('privacy').hidden=false,150)};document.getElementById('accept').onclick=()=>{window.accepts++;document.getElementById('privacy').hidden=true};document.getElementById('decline').onclick=()=>window.declines++;document.getElementById('print').onclick=()=>window.prints++;document.getElementById('cookieAccept').onclick=()=>window.cookies++;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};</script></body></html>`;
let total=0;
const check=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);total++;console.log('PASS '+name);};
const profile={...PROFILE,personal:{...PROFILE.personal,preferredLanguage:'English'},workAuth:{...PROFILE.workAuth,highSchoolDiplomaOrGED:'No',relativesEmployedHere:'No',profileVisibility:'Only recruiters managing jobs I apply to',jobNotifications:'Yes'},eeo:{...PROFILE.eeo,genderIdentity:'Man',sexualOrientation:'Heterosexual'}};
const path=join(dir,'career.html');await writeFile(path,html);
async function fixture(p=profile,responses=[]){return runFixture(path,{profile:p,responses,url:'https://career55.sapsf.eu/career?company=mcdonalds'});}
try{
 const {browser,page}=await fixture(profile,[{question:'Password',answer:'Saved#Password9',aliases:[]}]);
 try{
  const expected={email:PROFILE.personal.email,email2:PROFILE.personal.email,pw:'Saved#Password9',pw2:'Saved#Password9',first:PROFILE.personal.firstName,last:PROFILE.personal.lastName,country:'United States',state:'North Carolina',city:PROFILE.personal.city,zip:PROFILE.personal.zip,authorized:'Yes',sponsor:'No',diploma:'No',relatives:'No',salary:PROFILE.compensation.desiredSalary,ethnicity:'Not Hispanic or Latino',race:'Asian',genderIdentity:'Man',orientation:'Heterosexual',language:'English',residence:'United States',aliases:'N/A',unknown:'N/A',withoutInstruction:'',forbidden:'',number:'',date:'',naSelect:'N/A',helpNA:'N/A'};
  if(process.env.ZDEBUG) console.log(JSON.stringify(await page.evaluate(()=>window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f=>({id:f.el.id,label:f.label,key:f.rule?.key,plan:window.__applifill.planField(f,window.__applifill.state.fillProfile,{})}))),null,2));
  for(const [id,want] of Object.entries(expected))check(id,await page.locator('#'+id).inputValue(),want);
  check('male radio',await page.locator('#male').isChecked(),true);
  check('explicit profile visibility',await page.locator('#visibility2').isChecked(),true);
  check('explicit job alerts',await page.locator('#alerts').isChecked(),true);
  check('terms checkbox',await page.locator('#terms').isChecked(),true);
  check('marketing untouched',await page.locator('#marketing').isChecked(),false);
  check('asynchronous privacy accepted once',await page.evaluate(()=>window.accepts),1);
  check('Apply never submitted',await page.evaluate(()=>window.submits),0);
  check('cookie Accept untouched',await page.evaluate(()=>window.cookies),0);
  check('Decline untouched',await page.evaluate(()=>window.declines),0);
  check('Print untouched',await page.evaluate(()=>window.prints),0);
  const model=await page.evaluate(()=>window.model);
  for(const id of ['sponsor','diploma','ethnicity','aliases','naSelect','state','terms'])check(id+' change reaches model',model[id],id==='terms'?true:expected[id]);
  await page.locator('#aliases').fill('My chosen name');await page.locator('#aliases').blur();
  await page.locator('#terms').uncheck();await page.locator('#terms').blur();
  await page.evaluate(()=>window.__applifill.run({manual:true}));
  check('manual alias preserved',await page.locator('#aliases').inputValue(),'My chosen name');
  check('manual terms refusal preserved',await page.locator('#terms').isChecked(),false);
 }finally{await browser.close();}
 const cleared={...profile,personal:{...profile.personal,aliases:'Actual Alias'},workAuth:{},eeo:{}};
 const r=await fixture(cleared,[{question,answer:'Yes',aliases:[]}]);
 try{
  check('exact saved diploma answer',await r.page.locator('#diploma').inputValue(),'Yes');
  check('known alias wins over N/A',await r.page.locator('#aliases').inputValue(),'Actual Alias');
  check('missing saved password stays empty',await r.page.locator('#pw').inputValue(),'');
  check('missing orientation not guessed',await r.page.locator('#orientation').inputValue(),'-1');
  check('missing gender identity not guessed',await r.page.locator('#genderIdentity').inputValue(),'-1');
 }finally{await r.browser.close();}
 const t=await fixture({...cleared,education:PROFILE.education});
 try{check('higher education does not invent diploma declaration',await t.page.locator('#diploma').inputValue(),'-1');}finally{await t.browser.close();}
 const dynamicPath=join(dir,'dynamic-state.html');
 await writeFile(dynamicPath, `<!doctype html><title>Career application</title><form>${select('country','Country/Region',['United States','India'])}<div><label for="state">State/Province:</label><select id="state" disabled><option value="-1">No Selection</option></select></div><button type="submit">Apply</button></form><script>document.getElementById('country').onchange=()=>setTimeout(()=>{document.getElementById('state').innerHTML='<option value="-1">No Selection</option><option>North Carolina</option><option>Texas</option>';document.getElementById('state').disabled=false},700);</script>`);
 const dynamic=await runFixture(dynamicPath,{profile,responses:[],url:'https://career55.sapsf.eu/career?company=test'});
 try{check('asynchronous SAP State after Country',await dynamic.page.locator('#state').inputValue(),'North Carolina');}finally{await dynamic.browser.close();}
 const legacyPath=join(dir,'legacy-policy.html');
 await writeFile(legacyPath, `<!doctype html><title>Career application</title><form>${field('terms','Terms of Use:','checkbox')}<a href="javascript:document.getElementById('privacy').hidden=false;void(0)">Read and accept the data privacy statement.</a><button type="submit">Apply</button><div id="privacy" role="dialog" hidden><h2>Data Privacy Statement</h2><button type="button" onclick="window.accepts++;this.parentElement.hidden=true">Accept</button></div></form><script>window.accepts=0;window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};</script>`);
 const legacy=await runFixture(legacyPath,{profile,responses:[],url:'https://career55.sapsf.eu/career?company=test'});
 try{
  check('legacy JavaScript policy link opens and accepts',await legacy.page.evaluate(()=>window.accepts),1);
  check('plain Terms of Use checkbox accepts',await legacy.page.locator('#terms').isChecked(),true);
  check('legacy policy never submits Apply',await legacy.page.evaluate(()=>window.submits),0);
 }finally{await legacy.browser.close();}
 const accessiblePath=join(dir,'accessible-labels.html');
 await writeFile(accessiblePath, `<!doctype html><title>Create Account</title><form>${select('country','Country',['United States','India'])}${select('state','State',['North Carolina','Texas'])}<span id="passwordLabel">Choose Password</span><input id="textField" type="text" aria-label="Text field" aria-describedby="passwordLabel"><span id="langLabel">Preferred Language</span><select id="language" aria-label="Dropdown" aria-describedby="langLabel"><option value="-1">No Selection</option><option>English</option></select><button type="submit">Apply</button></form>`);
 const accessible=await runFixture(accessiblePath,{profile,responses:[{question:'Password',answer:'Saved#Password9',aliases:[]}],url:'https://career55.sapsf.eu/career?company=test'});
 try{
  check('shown password with SAP description label',await accessible.page.locator('#textField').inputValue(),'Saved#Password9');
  check('preferred language with SAP description label',await accessible.page.locator('#language').inputValue(),'English');
 }finally{await accessible.browser.close();}
}finally{await rm(dir,{recursive:true,force:true});}
console.log(`${total}/${total} career registration checks passed`);
