/** Pure, request-local taxonomy context. No database state or global mutation. */
export function createTaxonomyContext(value = {}) {
  if (value?.index instanceof Map) return value;
  const nodes = value.nodes ? value.nodes.map(n => ({...n})) : [];
  if (!value.nodes) {
    const flatten = (tree, parentId = null) => tree.forEach((node, position) => {
      nodes.push({id:node.id,label:node.label,parentId,position});
      if (node.children) flatten(node.children,node.id);
    });
    flatten(Array.isArray(value) ? value : value.tree ?? []);
  }
  const redirects = Object.assign(Object.create(null),value.redirects), index = new Map(), tree = [];
  const children = parentId => nodes.filter(n => n.parentId === parentId).sort((a,b) => a.position-b.position || a.id.localeCompare(b.id));
  const build = (parentId, target, path = [], ancestors = []) => {
    for (const node of children(parentId)) {
      const item = {...node,path:[...path,node.label],ancestors:[...ancestors]};
      index.set(node.id,item); target.push(item);
      const next = [];
      build(node.id,next,item.path,[...ancestors,node.id]);
      if (next.length) item.children = next;
    }
  };
  build(null,tree);
  const options = [...index.values()].map(({id,label,path,ancestors,parentId,position}) => ({id,label,path,ancestors,parentId,position}));
  return {revision:value.revision??0,nodes,tree,options,index,redirects};
}
export function resolveCategoryId(id, taxonomy) {
  let current = id;
  const seen = new Set();
  while (taxonomy?.redirects && Object.prototype.hasOwnProperty.call(taxonomy.redirects,current) && !seen.has(current)) {
    seen.add(current); current = taxonomy.redirects[current];
  }
  return current;
}
