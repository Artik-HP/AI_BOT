const path=require('node:path');
const CONFIG=require('../config');
const {getStore}=require('../commandSystem/store');
async function selfCheck(store=getStore()) {
  const checks=[],row=store.db.prepare('PRAGMA quick_check').get();checks.push({name:'Хранилище',ok:row.quick_check==='ok'});
  const registry=require('../commandSystem/registry').registry;
  checks.push({name:'Реестр команд',ok:[...registry.values()].every(c=>typeof c.handler==='function'&&c.schema?.type==='object')});
  try{CONFIG.validateConfig({telegram:false});checks.push({name:'Конфигурация',ok:true});}catch(error){checks.push({name:'Конфигурация',ok:false,code:error.code||error.name});}
  try {
    const {ESLint}=require('eslint');const lint=new ESLint({cwd:path.join(__dirname,'../..')});const results=await lint.lintFiles(['src/**/*.js','scripts/*.js','public/*.js']);
    checks.push({name:'Статический анализ JavaScript',ok:results.every(r=>r.errorCount===0),errors:results.reduce((n,r)=>n+r.errorCount,0),warnings:results.reduce((n,r)=>n+r.warningCount,0)});
  }catch(error){checks.push({name:'Статический анализ JavaScript',ok:false,code:error.code||error.name,detail:'Для анализа исходников нужны devDependencies: npm install.'});}
  return {checkedAt:new Date().toISOString(),checks,boundary:'Статический анализ и проверки структуры не гарантируют обнаружение всех логических ошибок. Проверка внешних сервисов выполняется отдельно.'};
}
module.exports={selfCheck};
