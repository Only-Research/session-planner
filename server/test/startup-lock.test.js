// Source-isolated cleanup checks; no processes, network, or real lock mutations.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../planner.js'),'utf8');
for(const scenario of ['owned','replaced','missing']) test(`startup cleanup preserves ${scenario} lock ownership`,async()=>{
 const runs='/synthetic-planner-runs',root=path.resolve(__dirname,'../..');let acquired=false,closed=false,unlinked=false;const errors=[];
 const runtime={status:'running',root,runs,port:12345,token:'synthetic',instance:'fixture-instance'};
 const fakeFs={mkdirSync(){},readFileSync(){if(!acquired)throw Object.assign(new Error('missing'),{code:'ENOENT'});return JSON.stringify(runtime);},openSync(){acquired=true;return 42;},writeFileSync(){},fstatSync(){return{dev:7,ino:11};},lstatSync(){if(scenario==='missing')throw Object.assign(new Error('missing'),{code:'ENOENT'});return{dev:7,ino:scenario==='replaced'?12:11,isFile:()=>true};},unlinkSync(){unlinked=true;},closeSync(){closed=true;}};
 const context={__dirname:path.resolve(__dirname,'..'),process:{argv:['node','planner.js','start','--runs',runs],env:{},pid:123},console:{log(){},error(e){errors.push(e);}},setTimeout,AbortSignal,fetch:async()=>({ok:true,json:async()=>({app:'session-planner',protocol:1,instance:runtime.instance,root,runs})}),require(name){if(name==='fs')return fakeFs;if(name==='child_process')return{spawn(){throw new Error('Unexpected spawn');}};return require(name);}};
 await vm.runInNewContext(source,context);
 assert.deepEqual(errors,[]);assert.equal(closed,true);assert.equal(unlinked,scenario==='owned');
});
