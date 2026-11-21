import { fail } from './domain.js';
const jwksCache = new Map();
function decodeBase64Url(value) {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid base64url');
  return Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
}
function decodeJson(value){return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));}
async function keysFor(team,refresh=false) {
  const cached=jwksCache.get(team);
  if(!refresh&&cached&&Date.now()-cached.time<3600000)return cached.keys;
  const response=await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`,{redirect:'manual',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Access keys unavailable');
  const body=await response.json();if(!Array.isArray(body.keys)||body.keys.length>50)throw new Error('Invalid Access keys');
  jwksCache.set(team,{keys:body.keys,time:Date.now()});return body.keys;
}
export async function verifyAccessJWT(token,team,audience) {
  try {
    if(typeof team!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(team)||typeof audience!=='string'||!audience.trim()||typeof token!=='string'||token.length>16000)return null;
    const parts=token.split('.');if(parts.length!==3)return null;
    const header=decodeJson(parts[0]),payload=decodeJson(parts[1]);
    if(header.alg!=='RS256'||typeof header.kid!=='string'||header.kid.length>200)return null;
    const seconds=Math.floor(Date.now()/1000),issuer=`https://${team}.cloudflareaccess.com`;
    if(payload.iss!==issuer||typeof payload.exp!=='number'||!Number.isFinite(payload.exp)||payload.exp<=seconds)return null;
    if(payload.nbf!==undefined&&(typeof payload.nbf!=='number'||payload.nbf>seconds))return null;
    if(!Array.isArray(payload.aud)||!payload.aud.includes(audience))return null;
    if(typeof payload.email!=='string'||payload.email.length>320||!/^\S+@\S+\.\S+$/.test(payload.email))return null;
    let keys=await keysFor(team),jwk=keys.find(k=>k.kid===header.kid);
    if(!jwk){keys=await keysFor(team,true);jwk=keys.find(k=>k.kid===header.kid);}
    if(!jwk||jwk.kty!=='RSA'||(jwk.alg&&jwk.alg!=='RS256')||(jwk.use&&jwk.use!=='sig'))return null;
    const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
    const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decodeBase64Url(parts[2]),new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    return valid?{email:payload.email}:null;
  }catch{return null;}
}
// Principal: {type,role,actor,email}. An Access JWT is always an owner (ADR-0006). The development bypass needs
// APP_ENV==='development' and a loopback host; its role comes from DEV_STAFF_ROLE (owner by default, manager, or the bypass is off).
export async function identity(request,env) {
  const hostname=new URL(request.url).hostname;
  if(env.AUTH_DEV_BYPASS==='true'&&env.APP_ENV==='development'&&['localhost','127.0.0.1','[::1]'].includes(hostname)){
    const role=env.DEV_STAFF_ROLE===undefined||env.DEV_STAFF_ROLE===''?'owner':env.DEV_STAFF_ROLE;
    if(role==='owner'||role==='manager')return{type:'dev',role,actor:'dev@localhost',email:'dev@localhost'};
    return null;
  }
  const assertion=request.headers.get('CF-Access-Jwt-Assertion');
  const cookie=(request.headers.get('Cookie')??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('CF_Authorization='))?.slice('CF_Authorization='.length);
  const verified=await verifyAccessJWT(assertion||cookie,env.CF_ACCESS_TEAM_NAME,env.CF_ACCESS_AUD);
  return verified?{type:'access',role:'owner',actor:verified.email,email:verified.email}:null;
}
export async function authenticated(request,env){return !!await identity(request,env);}
export function checkOrigin(request) {
  const origin=request.headers.get('Origin');
  if(!origin||origin!==new URL(request.url).origin)fail('Same-origin request required',403);
}
