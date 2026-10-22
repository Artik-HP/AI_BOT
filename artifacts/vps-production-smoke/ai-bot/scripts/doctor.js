require('dotenv').config({quiet:true});
require('../src/services/selfCheck').selfCheck().then(result=>{console.log(JSON.stringify(result,null,2));if(result.checks.some(c=>!c.ok))process.exitCode=1;}).catch(error=>{console.error('Диагностика не выполнена:',error.code||error.name);process.exitCode=1;});
