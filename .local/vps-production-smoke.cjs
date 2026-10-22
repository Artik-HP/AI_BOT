const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const payload = path.resolve(__dirname, '../artifacts/vps-production-smoke/ai-bot');
const runtimeRequire = createRequire(path.join(payload, 'package.json'));
const state = fs.mkdtempSync(path.join(__dirname, 'vps-smoke-state-'));
const envFile = path.join(state, 'config.env');
const env = {
  NODE_ENV: 'production', BOT_TOKEN: '', OPENROUTER_API_KEY: '',
  BOT_ACCESS_PASSWORD_HASH: '', ACCOUNT_ASSISTANT_ENABLED: 'false', BOT_TO_BOT_ENABLED: 'false',
  HOST: '127.0.0.1', WEB_HOST: '127.0.0.1', WEB_PORT: '0', WEBHOOK_URL: '',
  WEB_ACCESS_TOKEN: 'synthetic-vps-web-access-token-1234567890', WEB_SECURE_COOKIE: 'false',
  MEMORY_BACKEND: 'sqlite', MEMORY_FILE: path.join(state, 'memory.json'),
  COMMAND_DB_FILE: path.join(state, 'commands.sqlite'),
  INTERACTIVE_STATE_FILE: path.join(state, 'interactive-state.json'), CONFIG_ENV_FILE: envFile,
};
fs.writeFileSync(envFile, Object.entries(env).map(([k,v]) => k+'='+v.replaceAll('\\','/')).join('\n'));
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(systemroot|windir|path|pathext|temp|tmp|comspec)$/i.test(key)));
childEnv.DOTENV_CONFIG_PATH = envFile;
childEnv.CONFIG_ENV_FILE = envFile;
let child;
async function launch() {
  child = spawn(process.execPath, ['--require', 'dotenv/config', 'src/web.js'], {cwd:payload,env:childEnv,stdio:['ignore','pipe','pipe'],windowsHide:true});
  return new Promise((resolve,reject) => {
    let output='';
    const timer=setTimeout(() => reject(new Error('Packaged web startup timed out')),15000);
    child.stdout.on('data', chunk => { output+=chunk.toString(); const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if(match){clearTimeout(timer);resolve(match[0]);} });
    child.stderr.on('data', () => {});
    child.once('error', error => {clearTimeout(timer);reject(error);});
    child.once('exit', code => {clearTimeout(timer);if(!output.match(/http:\/\/127\.0\.0\.1:/))reject(new Error('Packaged web exited '+code));});
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const current=child; child=null;
  await new Promise(resolve => {current.once('exit',resolve);current.kill();});
}
async function main() {
  assert.ok(!fs.existsSync(path.join(payload,'node_modules/eslint')));
  for (const module of ['dotenv','express','node-telegram-bot-api','telegram','axios','qrcode','marked','dompurify']) runtimeRequire.resolve(module);
  let base=await launch();
  assert.deepEqual(await (await fetch(base+'/health')).json(),{ok:true});
  for(const resource of ['/','/app.js','/product.js','/vendor/marked.js','/vendor/purify.js']) assert.equal((await fetch(base+resource)).status,200,resource);
  assert.equal((await fetch(base+'/api/session')).status,401);
  const login=await fetch(base+'/api/session',{headers:{'X-Access-Token':env.WEB_ACCESS_TOKEN}});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0], csrf=(await login.json()).csrf;
  async function command(id,args,key) {
    const response=await fetch(base+'/api/commands/'+id,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':key},body:JSON.stringify({args})});
    assert.equal(response.status,200);return response.json();
  }
  assert.match((await command('calculator','2+2','calc')).text,/4/);
  await command('notes','add VPS persistence sentinel','note');
  const update=await fetch(base+'/api/admin/provider-key',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({provider:'openrouter',key:'synthetic-key-no-network-request'})});
  assert.equal(update.status,200);
  assert.ok(fs.readFileSync(envFile,'utf8').includes('synthetic-key-no-network-request'));
  assert.ok(!fs.existsSync(path.join(payload,'.env')));
  await stop();
  base=await launch();
  assert.match((await command('notes','list','read-after-restart')).text,/VPS persistence sentinel/);
  const preferences=await (await fetch(base+'/api/preferences',{headers:{Cookie:cookie}})).json();
  assert.equal(preferences.providers.openrouter.configured,true);
  await stop();
  console.log('PRODUCTION_BUNDLE_SMOKE_PASS: clean production install, HTTP/UI assets, auth, commands, SQLite persistence, external dotenv settings and restart. No Telegram or AI requests.');
}
main().catch(error => {console.error(error.message);process.exitCode=1;}).finally(stop);

