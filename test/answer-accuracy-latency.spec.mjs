import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('test/fixtures/workday-source-prompt.html', root), 'utf8');
const scripts = await Promise.all(['lib/field-map.js', 'lib/matcher.js', 'lib/ats.js', 'content/autofill.js'].map(p => readFile(process.env.APPLI_FILL_EXT ? resolve(process.env.APPLI_FILL_EXT,p) : new URL(`extension/${p}`, root), 'utf8')));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };
const profile = { _id: 'p1', personal: {firstName:'Test',lastName:'Applicant',email:'applicant@example.test'}, workAuth:{authorizedToWork:'Yes',requireSponsorship:'No',previouslyEmployedHere:'No',howDidYouHear:'LinkedIn'}, experience:[],education:[],eeo:{} };
async function open(url, html, responses = [], premium = false, cxl = null) {
  const page = await browser.newPage();
  await page.addInitScript(({profile,responses,premium,cxl}) => {
    window.__APPLI_FILL_TEST = true;
    if(cxl) window.__cxl=cxl;
    window.__session = {profile,profiles:[profile],responses,premium,settings:{showOverlay:false,reuseSavedResponses:true,fillDelayMs:0,trackAutomatically:false}};
    window.chrome = {runtime:{lastError:null,onMessage:{addListener(){}},sendMessage(m,cb){
      const data = m.type === 'APPLI_FILL_GET_SESSION' ? window.__session : m.type === 'APPLI_FILL_ANSWER_BATCH' ? {answers:[]} : {};
      setTimeout(() => cb?.({ok:true,data}),0);
    }}};
  }, {profile,responses,premium,cxl});
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:html}));
  await page.goto(url);
  for (const content of scripts) await page.addScriptTag({content});
  return page;
}
const select = (id,q) => `<div><label for="${id}">${q}</label><select id="${id}"><option value="">Select...</option><option>Yes</option><option>No</option></select></div>`;
try {
  for (const url of ['https://boards.greenhouse.io/acme/jobs/123','https://acme.wd1.myworkdayjobs.com/job/123/apply','https://careers.example.test/apply']) {
    const html = `<html><body><h1>Application</h1><form>${select('authorized','Are you legally authorized to work in the United States?')}${select('sponsor','Will you require sponsorship?')}${select('without','Can you work without sponsorship?')}${select('notAuthorized','Are you not legally authorized to work in the United States?')}${select('longLegal','Are you authorized to legally work in the location in which you are expressing an interest without requiring sponsorship from an employer? If you are currently on a student visa, work visa, or any other type of government sanctioned work status, and will require employer immigration sponsorship, please select No to provide additional details. Based upon the work location, documentation may be required.')}${select('saved','Have you completed the required assessment?')}${select('parenthetical','Have you completed the required assessment (without assistance)?')}${select('different','Have you completed the required assessment and interview?')}</form></body></html>`;
    const page = await open(url,html,[{question:'Have you completed the required assessment?',answer:'Yes'}, {question:'Have you not completed the required assessment?',answer:'No'}]);
    await page.evaluate(() => window.__applifill.run({manual:true}));
    const values = await page.locator('select').evaluateAll(nodes => Object.fromEntries(nodes.map(n => [n.id,n.value])));
    check(`${new URL(url).hostname}: profile and saved Yes/No answers`, () => assert.deepEqual(values,{authorized:'Yes',sponsor:'No',without:'Yes',notAuthorized:'No',longLegal:'Yes',saved:'Yes',parenthetical:'',different:''}));
    const matches = await page.evaluate(() => {
      const M=window.APPLI_FILL_MATCHER;
      const a={question:'Have you completed the required assessment?',answer:'Yes'};
      const oldKey=M.normalizeQuestion(a.question);
      const rows=[{...a,normalizedKey:oldKey}];
      const many=Array.from({length:1500},(_,i)=>({question:`Have you completed assessment number ${i}?`,answer:i%2?'Yes':'No'}));
      many.push({question:'Have you completed the required assessment?',aliases:['Did you finish the mandatory assessment?'],answer:'Yes'});
      const start=performance.now();
      for(let i=0;i<200;i++) M.findSavedAnswer('Did you finish the mandatory assessment?',many);
      return {
        parenthesized:M.findSavedAnswer('Have you completed the required assessment (without assistance)?',rows),
        negated:M.findSavedAnswer('Have you not completed the required assessment?',rows),
        conjunction:M.findSavedAnswer('Have you completed the required assessment and interview?',rows),
        alias:M.findSavedAnswer('Did you finish the mandatory assessment?',many)?.answer,
        conflicting:M.findSavedAnswer(a.question,[a,{...a,answer:'No'}]),
        elapsed:performance.now()-start,
        adjacent: M.matchRule(document.querySelector('#authorized'), 'Are you legally authorized to work in the United States? | Will you require sponsorship?', window.APPLI_FILL_FIELD_MAP)?.key,
        never: M.yesNoId('I have never been employed here'),
      };
    });
    check('qualifications, negation and added clauses cannot collide',()=>{assert.equal(matches.parenthesized,null);assert.equal(matches.negated,null);assert.equal(matches.conjunction,null);assert.equal(matches.conflicting,null);assert.equal(matches.alias,'Yes');});
    check(`indexed lookups: 1501 answers, 200 queries (${Math.round(matches.elapsed)}ms)`,()=>assert.ok(matches.elapsed<1000));
    check('adjacent sponsorship wording cannot change authorization',()=>assert.equal(matches.adjacent,'authorizedToWork'));
    check('never is read as a negative answer',()=>assert.equal(matches.never,'no'));
    await page.close();
  }
  // A slow unknown menu must not prevent already-known answers from filling.
  const page = await open('https://acme.wd1.myworkdayjobs.com/job/123/apply',source,[],true);
  await page.evaluate(() => {
    window.__sourceBlurCommits=0;
    document.querySelector('#source--source').addEventListener('blur',()=>{
      if(document.querySelector('[data-automation-id="selectedItem"]')) window.__sourceBlurCommits++;
    });
    const block=document.createElement('div');
    block.innerHTML='<div data-automation-id="formField-arrangement"><label for="arrangement">Which work arrangement do you prefer?</label><button id="arrangement" type="button" aria-haspopup="listbox">Select...</button></div><div data-automation-id="formField-unknown"><label for="unknown">Which office amenities matter most to you?</label><button id="unknown" type="button" aria-haspopup="listbox">Select...</button></div>';
    document.querySelector('[data-automation-id="applyFlowPage"]').append(block);
    window.__session.responses.push({question:'Which work arrangement do you prefer?',answer:'Remote'});
    const button=document.querySelector('#arrangement');
    button.addEventListener('click',()=>{
      const list=document.createElement('div');list.setAttribute('role','listbox');
      for(const text of ['Remote','Hybrid']) {const option=document.createElement('div');option.setAttribute('role','option');option.textContent=text;option.onclick=()=>{button.textContent=text;list.remove();};list.append(option);}
      document.body.append(list);
    });
    const M=window.APPLI_FILL_MATCHER;
    const read=M.readComboboxOptions;
    M.readComboboxOptions=async (el,...args)=>{
      if(el.id==='unknown') {window.__knownAtAi=document.querySelector('#arrangement').textContent;await new Promise(r=>setTimeout(r,600));return ['Quiet space','Gym'];}
      return read(el,...args);
    };
    const pick=M.setPromptChoice;
    M.setPromptChoice=async (...args)=>{window.__knownAtSource=document.querySelector('#arrangement').textContent;return pick(...args);};
  });
  await page.evaluate(() => window.__applifill.run({manual:true}));
  const timing = await page.evaluate(()=>({source:window.__knownAtSource,ai:window.__knownAtAi,pill:document.querySelector('[data-automation-id="selectedItem"]')?.title,blurCommits:window.__sourceBlurCommits}));
  check('known dropdown finishes before the source picker',()=>assert.equal(timing.source,'Remote'));
  check('unknown AI dropdown collection follows known answers',()=>assert.equal(timing.ai,'Remote'));
  check('source picker commits a validated LinkedIn pill',()=>assert.equal(timing.pill,'LinkedIn'));
  check('the selected source triggers one blur validation',()=>assert.equal(timing.blurCommits,1));
  await page.close();
  const oracle = await open('https://eklm.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/34866/apply/section/2/',
    await readFile(new URL('test/fixtures/oracle-cx-live.html', root),'utf8'),[],false,{section:2,latency:30});
  await oracle.evaluate(()=>window.__applifill.run({manual:true}));
  const oracleAnswer = await oracle.evaluate(()=>window.__model['300000469539525-24']);
  check('Oracle long authorization prompt preserves without-sponsorship polarity',()=>assert.equal(oracleAnswer,'Yes'));
  await oracle.close();
} finally {await browser.close();}
console.log(`${passed}/${passed} accuracy and latency checks passed`);
