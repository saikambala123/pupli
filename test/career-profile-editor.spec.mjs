/** Real ProfileEditor interaction and save-payload test in offline Chromium. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {chromium} from 'playwright';
const require=createRequire(import.meta.url);
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
function packageDir(name){let path=dirname(require.resolve(name));while(!path.endsWith('node_modules/'+name)&&path!==dirname(path))path=dirname(path);return path;}
const vendor=await Promise.all([
 readFile(join(packageDir('react'),'umd/react.development.js'),'utf8'),
 readFile(join(packageDir('react-dom'),'umd/react-dom.development.js'),'utf8'),
 readFile(join(packageDir('lucide-react'),'dist/umd/lucide-react.js'),'utf8')
]);
const source=await readFile(join(root,'src/components/dashboard/ProfileEditor.tsx'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
let total=0;
function check(name,actual,expected){assert.deepEqual(actual,expected,name);total++;console.log('PASS '+name);}
try{
 const page=await browser.newPage();
 await page.setContent('<!doctype html><div id="root"></div>');
 await page.addScriptTag({content:vendor[0]});await page.addScriptTag({content:vendor[1]});
 await page.addScriptTag({content:'window.react=window.React;'});await page.addScriptTag({content:vendor[2]});
 await page.evaluate(code=>{
  window.requests=[];window.saved=[];
  const modules={react:window.React,'lucide-react':window.LucideReact,'@/lib/client-api':{
   apiPatch:async(url,payload)=>{window.requests.push({url,payload});return {ok:true,data:{...payload,_id:'profile-test'}};},apiDelete:async()=>({ok:true})
  }};
  const module={exports:{}};
  new Function('require','module','exports',code)(name=>modules[name],module,module.exports);
  window.ReactDOM.createRoot(document.getElementById('root')).render(window.React.createElement(module.exports.default,{initial:{_id:'profile-test',label:'Career profile',personal:{},workAuth:{},eeo:{},documents:[]},onSaved:p=>window.saved.push(p)}));
 },compiled);
 await page.getByRole('button',{name:'Work eligibility',exact:true}).click();
 // Scope to the label's own wrapper; avoid unrelated selectors in the grid.
 const field=page.locator('label').filter({hasText:'Do you have a minimum education level of high school diploma or GED?'}).locator('..').locator('select');
 check('diploma field has no implicit answer',await field.inputValue(),'');
 await field.selectOption('Yes');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.waitForFunction(()=>window.requests.length===1&&window.saved.length===1);
 check('Yes reaches profile update',await page.evaluate(()=>window.requests[0].payload.workAuth.highSchoolDiplomaOrGED),'Yes');
 check('correct profile endpoint',await page.evaluate(()=>window.requests[0].url),'/api/profiles/profile-test');
 check('saved callback retains diploma answer',await page.evaluate(()=>window.saved[0].workAuth.highSchoolDiplomaOrGED),'Yes');
 await field.selectOption('No');
 await page.getByRole('button',{name:/^(?:Save changes|Saved)$/}).click();
 await page.waitForFunction(()=>window.requests.length===2);
 check('No can replace Yes',await page.evaluate(()=>window.requests[1].payload.workAuth.highSchoolDiplomaOrGED),'No');
 await field.selectOption('');
 await page.getByRole('button',{name:/^(?:Save changes|Saved)$/}).click();
 await page.waitForFunction(()=>window.requests.length===3);
 check('declaration can be cleared',await page.evaluate(()=>window.requests[2].payload.workAuth.highSchoolDiplomaOrGED),'');
}finally{await browser.close();}
console.log(`${total}/${total} profile editor checks passed`);
