// URL subpaths for manager-console tools. Owners use /admin/<tool> (Cloudflare Access),
// staff use /staff/<tool> (Google staff session). The base prefix selects the credential;
// the Worker and API enforce authentication and permissions, this module only maps URLs.
export const ADMIN_TOOLS = [
  {id:'dashboard', segment:'dashboard'},
  {id:'catalog', segment:'catalog'},
  {id:'suppliers', segment:'suppliers'},
  {id:'sync', segment:'sync'},
  {id:'duplicates', segment:'duplicates'},
  {id:'recognition', segment:'recognition'},
  {id:'storefront', segment:'storefront'},
  {id:'staff', segment:'team'},
  {id:'audit', segment:'audit'},
  {id:'orders', segment:'orders'},
  {id:'media', segment:'media'},
  {id:'infra', segment:'infra'}
];
export const DEFAULT_TOOL = 'catalog';

export function consoleBase(pathname = '') {
  for (const base of ['/admin', '/staff']) if (pathname === base || pathname.startsWith(base + '/')) return base;
  return null;
}

// Returns the tool id for a console path, DEFAULT_TOOL for the bare base, or null for an unknown subpath.
export function toolFromPath(pathname = '') {
  const base = consoleBase(pathname);
  if (!base) return null;
  const segment = pathname.slice(base.length).replace(/^\/+|\/+$/g, '');
  if (!segment) return DEFAULT_TOOL;
  return ADMIN_TOOLS.find(tool => tool.segment === segment)?.id || null;
}

export function toolPath(base, toolId) {
  const tool = ADMIN_TOOLS.find(item => item.id === toolId);
  if (!tool || (base !== '/admin' && base !== '/staff')) throw new Error(`Unknown console route: ${base} ${toolId}`);
  return `${base}/${tool.segment}`;
}
