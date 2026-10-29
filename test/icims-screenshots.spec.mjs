import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runFixture,PROFILE} from './portals/harness.mjs';
const dir=await mkdtemp(join(tmpdir(),'applifill-icims-'));
const input=(id,label,attrs='')=>`<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attrs}></div>`;
const select=(id,label,options,attrs='')=>`<div class="field"><label for="${id}">${label}</label><select id="${id}" ${attrs}><option value="">— Make a Selection —</option>${options.map(o=>`<option>${o}</option>`).join('')}</select></div>`;
const style='<style>body{font:16px sans-serif;margin:20px}.field{margin:8px}label{display:block}input,select{padding:6px}td{padding:10px}input{border:1px solid #333}table{width:100%}</style>';
const profile={...PROFILE,workAuth:{...PROFILE.workAuth,textMessageConsent:'Yes',previouslyEmployedHere:'No'},personal:{...PROFILE.personal,preferredName:'Preferred'},compensation:{...PROFILE.compensation,salaryCurrency:'USD'}};
let total=0,failures=0;
function check(name,actual,want){total++;try{assert.deepEqual(actual,want);console.log('PASS '+name);}catch{failures++;console.error(`FAIL ${name}: ${JSON.stringify(actual)} expected ${JSON.stringify(want)}`);}}
async function fixture(name,body,p=profile){const file=join(dir,name+'.html');await writeFile(file,`<!doctype html><title>iCIMS career application</title>${style}<div class="iCIMS_MainWrapper"><h1>Apply - Discount Tire</h1><form>${body}<button type="submit">Submit Profile</button></form></div><script>window.submits=0;window.model={};document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};document.addEventListener('change',e=>window.model[e.target.id]=e.target.type==='checkbox'?e.target.checked:e.target.value);document.querySelector('#source')?.addEventListener('change',()=>setTimeout(()=>{const el=document.getElementById('detail');el.disabled=false;el.innerHTML='<option value="">— Make a Selection —</option><option>LinkedIn</option><option>Indeed</option>'},500));</script>`);return runFixture(file,{profile:p,responses:[],url:'https://careers-discounttire.icims.com/jobs/1234/profile'});}
try{
 const r=await fixture('modern',`${input('login','Login')}${input('pw','Password','type="password"')}${input('pw2','Password (Re-enter)','type="password"')}${input('fn','Legal First Name')}${input('ln','Last Name')}${input('preferred','Preferred First Name')}${input('email','Email','type="email"')}
 <section><h2>Phones (1)</h2>${select('phoneType','Type',['Mobile','Home','Work'])}${input('phone','Number','type="tel"')}</section>
 ${select('sms','Is it OK for us to send you text messages?',['Yes','No'])}
 <section><h2>Addresses (1)</h2>${select('addressType','Type',['Home','Business'])}${input('street','Address')}${input('line2','Address 2')}${input('city','City')}${input('zip','Zip/Postal Code')}${select('country','Country',['United States','India'])}${select('state','State/Province',['North Carolina','Washington'])}</section>
 ${select('source','How did you hear about us?',['Social Media','Job Board','Other'])}${select('detail','Please specify',[],'disabled')}
 ${select('currency','Desired Pay (Currency / Amount)',['USD $','INR ₹'])}${input('salary','Desired Pay (Currency / Amount)','type="number"')}
 ${select('referral','Were you referred by a current employee? If so, please enter their information below.',['Yes','No'])}${input('refFirst',"Referrer's First Name")}${input('refLast',"Referrer's Last Name")}${input('refID',"Referrer's Employee ID (if unknown, please leave blank)")}
 ${select('highest','Highest level of education completed',["High School Diploma","Bachelor's Degree","Master's Degree"])}
 ${select('prior',"Have you previously been employed by Discount Tire, America's Tire, or any of its subsidiaries or affiliates?",['Yes','No'])}
 ${input('signature','By typing your name in here, you acknowledge the statements above.')}`);
 try{
  const expected={login:profile.personal.email,fn:profile.personal.firstName,ln:profile.personal.lastName,preferred:'Preferred',email:profile.personal.email,phoneType:'Mobile',phone:profile.personal.phone,sms:'Yes',addressType:'Home',street:profile.personal.address,line2:profile.personal.addressLine2,city:profile.personal.city,zip:profile.personal.zip,country:profile.personal.country,state:profile.personal.state,source:'Social Media',detail:'LinkedIn',currency:'USD $',salary:profile.compensation.desiredSalary,referral:'No',refFirst:'',refLast:'',refID:'',highest:"Master's Degree",prior:'No',signature:[profile.personal.firstName,profile.personal.middleName,profile.personal.lastName].filter(Boolean).join(' ')};
  for(const[id,want]of Object.entries(expected))check(id,await r.page.locator('#'+id).inputValue(),want);
  check('not submitted',await r.page.evaluate(()=>window.submits),0);
  const model=await r.page.evaluate(()=>window.model);
  for(const id of ['street','zip','detail','sms','signature'])check(id+' portal model',model[id],expected[id]);
  if(process.env.ZDEBUG||failures)console.log(JSON.stringify(await r.page.evaluate(()=>window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f=>({id:f.el.id,label:f.label,key:f.rule?.key,plan:window.__applifill.planField(f,window.__applifill.state.fillProfile,{})}))),null,2));
  await r.page.locator('#street').fill('Manual street');await r.page.locator('#street').blur();await r.page.evaluate(()=>window.__applifill.run({manual:true}));check('manual street preserved',await r.page.locator('#street').inputValue(),'Manual street');
 }finally{await r.browser.close();}
 const table=await fixture('iform',`<h2>PERSONAL</h2><table><tr><td>Last Name:</td><td>First Name:</td><td>Middle:</td></tr><tr><td><input id="iform-last"></td><td><input id="iform-first"></td><td><input id="iform-middle"></td></tr></table><h2>CURRENT ADDRESS INFORMATION</h2><table><tr><td>Current Address Line 1<input id="iform-street"></td></tr><tr><td>Current Address Line 2<input id="iform-line2"></td></tr><tr><td>City<input id="iform-city"></td></tr><tr><td>Country<select id="iform-country"><option>United States</option></select></td><td>State/Province<select id="iform-state"><option>North Carolina</option></select></td><td>Zip<input id="iform-zip"></td></tr></table><h2>PRE-EMPLOYMENT STATEMENT</h2><p>Checking the box is equivalent to a handwritten signature.</p><table><tr><td><input id="iform-consent" type="checkbox"> Signature of Applicant</td></tr></table>`);
 try{
  for(const[id,want]of Object.entries({'iform-last':profile.personal.lastName,'iform-first':profile.personal.firstName,'iform-middle':profile.personal.middleName,'iform-street':profile.personal.address,'iform-line2':profile.personal.addressLine2,'iform-city':profile.personal.city,'iform-zip':profile.personal.zip}))check(id,await table.page.locator('#'+id).inputValue(),want);
  check('signature checkbox',await table.page.locator('#iform-consent').isChecked(),true);check('iForm not submitted',await table.page.evaluate(()=>window.submits),0);
  if(process.env.ZDEBUG||failures)console.log(JSON.stringify(await table.page.evaluate(()=>window.__applifill.collectFields(window.APPLI_FILL_ATS.detect()).map(f=>({id:f.el.id,label:f.label,key:f.rule?.key}))),null,2));
 }finally{await table.browser.close();}
 const referred=await fixture('referred',`<section><h2>Phones (1)</h2>${select('variantType','Type',['Home','Cellular','Work'])}</section>${select('referral','Were you referred by a current employee? If so, please enter their information below.',['Yes','No'])}${input('first',"Referrer's First Name")}${input('last',"Referrer's Last Name")}${input('employee',"Referrer's Employee ID (if unknown, please leave blank)")}`,{...profile,workAuth:{...profile.workAuth,referredBy:'',referrerFirstName:'Alex',referrerLastName:'Taylor',referrerEmployeeId:'EMP-42'}});
 try{check('Cellular phone synonym',await referred.page.locator('#variantType').inputValue(),'Cellular');for(const[id,want]of Object.entries({referral:'Yes',first:'Alex',last:'Taylor',employee:'EMP-42'}))check('referrer '+id,await referred.page.locator('#'+id).inputValue(),want);}finally{await referred.browser.close();}
}finally{await rm(dir,{recursive:true,force:true});}
console.log(`${total-failures}/${total} iCIMS screenshot checks passed`);process.exitCode=failures?1:0;
