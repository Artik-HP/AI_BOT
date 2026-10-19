function emit(level,event,details={}) {
  const name=String(event).replace(/https?:\/\/\S+|sk-[A-Za-z0-9_-]+|\d{6,}/g,'[redacted]').slice(0,160);
  const fields={};if(details&&typeof details==='object')for(const key of ['code','status','command','durationMs','port','ok'])if(['string','number','boolean'].includes(typeof details[key]))fields[key]=String(details[key]).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,100);
  console[level==='error'?'error':level==='warn'?'warn':'log'](JSON.stringify({time:new Date().toISOString(),level,event:name,...fields}));
}
function info(event,details){emit('info',event,details);}
function warn(event,details){emit('warn',event,details);}
function error(event,details){emit('error',event,details);}

module.exports = {
  info,
  warn,
  error
};
