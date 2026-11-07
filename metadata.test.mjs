import test from 'node:test';
import assert from 'node:assert/strict';
import {skillEvidence} from './metadata.mjs';
const sha='a'.repeat(40),child='b'.repeat(40);
const tree=(entries,truncated=false,id=sha)=>({sha:id,tree:entries,truncated});
test('complete recursive tree proves exact SKILL.md presence; truncated partial matches are discarded',async()=>{
 const reads=[];
 const result=await skillEvidence('a/b','main',async(path,options)=>{
  reads.push(path);assert.equal(options.maxBytes,32*1024*1024);
  if(path.endsWith('/main?recursive=1'))return tree([{type:'blob',path:'false/SKILL.md'}],true);
  if(path.endsWith('/'+sha))return tree([{type:'tree',path:'skills',sha:child}]);
  if(path.endsWith('/'+child+'?recursive=1'))return tree([{type:'blob',path:'one/SKILL.md'},{type:'blob',path:'two/skill.md'}],false,child);
  throw new Error('Unexpected '+path);
 },'2026-11-07T12:00:00Z');
 assert.deepEqual(result.paths,['skills/one/SKILL.md']);assert.equal(result.evidence.complete,true);assert.equal(reads.length,3);
});
test('size overflow splits the tree; incomplete, malformed and exhausted traversals cannot prove absence',async()=>{
 let calls=0;
 const result=await skillEvidence('a/b','main',async path=>{calls++;if(path.endsWith('?recursive=1'))throw new Error('Response exceeds size budget');return tree([{type:'blob',path:'SKILL.md'}]);},'now');
 assert.deepEqual(result.paths,['SKILL.md']);assert.equal(calls,2);
 await assert.rejects(skillEvidence('a/b','main',async()=>tree([],true),'now'),/incomplete/);
 await assert.rejects(skillEvidence('a/b','main',async()=>({tree:[]}),'now'),/Invalid/);
 await assert.rejects(skillEvidence('a/b','main',async()=>tree([{type:'blob',path:'../SKILL.md'}]),'now'),/Invalid/);
 await assert.rejects(skillEvidence('a/b','main',async()=>{throw new Error('HTTP 403');},'now'),/HTTP 403/);
 const empty=await skillEvidence('a/b','main',async()=>tree([]),'now');assert.deepEqual(empty.paths,[]);assert.equal(empty.evidence.complete,true);
});
test('tree request and depth budgets fail without returning a false absence',async()=>{
 await assert.rejects(skillEvidence('a/b','main',async path=>{
  if(path.endsWith('?recursive=1'))return tree([],true,path.includes(child)?child:sha);
  if(path.includes('/main')||path.endsWith('/'+sha))return tree(Array.from({length:50},(_,i)=>({type:'tree',path:'d'+i,sha:child})));
  return tree([],false,child);
 },'now'),/request budget/);
 await assert.rejects(skillEvidence('a/b','main',async path=>path.endsWith('?recursive=1')?tree([],true):tree([{type:'tree',path:'nested',sha:child}]),'now'),/depth budget/);
});
