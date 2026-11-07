// GitHub recursive trees can reach 7 MB or be truncated. Only a complete
// traversal can establish that a repository contains no SKILL.md files.
export async function skillEvidence(name,branch,request,checkedAt) {
 let requests=0,entries=0,rootSha;
 const paths=[];
 const get=async(ref,recursive)=>{
  if(++requests>96)throw new Error('Skill tree traversal request budget reached');
  const result=await request(`/repos/${name}/git/trees/${encodeURIComponent(ref)}${recursive?'?recursive=1':''}`,{maxBytes:32*1024*1024});
  if(!result||!Array.isArray(result.tree)||typeof result.truncated!=='boolean'||typeof result.sha!=='string')throw new Error('Invalid Git tree response');
  for(const node of result.tree)if(typeof node.path!=='string'||!node.path||node.path.startsWith('/')||node.path.split('/').some(p=>p==='..'||p==='.'||!p)||typeof node.type!=='string')throw new Error('Invalid Git tree entry');
  entries+=result.tree.length;
  if(entries>400000)throw new Error('Skill tree traversal entry budget reached');
  return result;
 };
 const visit=async(ref,prefix='',depth=0)=>{
  if(depth>32)throw new Error('Skill tree traversal depth budget reached');
  let tree;
  try {tree=await get(ref,true);}
  catch(error){if(!/Response exceeds size budget/.test(error.message))throw error;}
  if(!prefix&&tree)rootSha=tree.sha;
  if(tree&&!tree.truncated){for(const node of tree.tree)if(node.type==='blob'&&/(^|\/)SKILL\.md$/.test(node.path))paths.push(prefix+node.path);return;}
  // Pin all fallback reads to the immutable tree observed on the first read.
  const flat=await get(tree?.sha??ref,false);if(!prefix)rootSha=flat.sha;
  if(flat.truncated)throw new Error('Non-recursive Git tree is incomplete');
  for(const node of flat.tree) {
   if(node.type==='blob'&&node.path==='SKILL.md')paths.push(prefix+node.path);
   if(node.type==='tree') {
    if(!/^[a-f0-9]{40}$/.test(node.sha??''))throw new Error('Invalid subtree identity');
    await visit(node.sha,prefix+node.path+'/',depth+1);
   }
  }
 };
 await visit(branch);
 return {paths:[...new Set(paths)].sort(),evidence:{kind:'git_tree',checked_at:checkedAt,tree_sha:rootSha,complete:true,requests}};
}
