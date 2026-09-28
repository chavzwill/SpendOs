const crypto=require('crypto');

function safeEqual(left,right){
  const a=Buffer.from(String(left??''),'utf8');
  const b=Buffer.from(String(right??''),'utf8');
  if(a.length!==b.length) return false;
  return crypto.timingSafeEqual(a,b);
}

function cookieMap(header=''){
  const out={};
  for(const part of String(header||'').split(';')){
    const index=part.indexOf('=');
    if(index<1) continue;
    const key=part.slice(0,index).trim();
    const value=part.slice(index+1).trim();
    if(key) out[key]=value;
  }
  return out;
}

function createUiAuth({
  username='admin',
  password='',
  secret='',
  production=false,
  maxAgeSeconds=8*60*60
}={}){
  if(production && !password) throw new Error('SPENDOS_UI_PASSWORD is required when NODE_ENV=production');
  if(production && String(secret).length<32) throw new Error('SPENDOS_SESSION_SECRET must be at least 32 characters when NODE_ENV=production');

  const enabled=Boolean(password&&secret);
  const sign=input=>crypto.createHmac('sha256',String(secret)).update(input).digest('base64url');

  function createToken(user=username,now=Date.now()){
    if(!enabled) return null;
    const payload=Buffer.from(JSON.stringify({user,exp:now+(maxAgeSeconds*1000)})).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }

  function verifyToken(token,now=Date.now()){
    if(!enabled) return production?null:{user:'local',mode:'open_local'};
    const [payload,signature,...extra]=String(token||'').split('.');
    if(!payload||!signature||extra.length||!safeEqual(signature,sign(payload))) return null;
    try{
      const parsed=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
      if(!parsed.user||!Number.isFinite(parsed.exp)||parsed.exp<=now) return null;
      return {user:String(parsed.user),exp:parsed.exp,mode:'session'};
    }catch{return null;}
  }

  function sessionFromRequest(req){
    if(!enabled) return production?null:{user:'local',mode:'open_local'};
    const token=cookieMap(req.headers.cookie).spendos_session;
    return verifyToken(token);
  }

  function authenticate(user,pass){
    if(!enabled) return production?null:{user:'local',mode:'open_local'};
    if(!safeEqual(user,username)||!safeEqual(pass,password)) return null;
    return {user:username,mode:'session'};
  }

  function sessionCookie(user){
    const token=createToken(user);
    if(!token) return null;
    return [
      `spendos_session=${token}`,
      'Path=/',
      `Max-Age=${maxAgeSeconds}`,
      'HttpOnly',
      'SameSite=Strict',
      production?'Secure':null
    ].filter(Boolean).join('; ');
  }

  function clearCookie(){
    return ['spendos_session=','Path=/','Max-Age=0','HttpOnly','SameSite=Strict',production?'Secure':null].filter(Boolean).join('; ');
  }

  return {enabled,username,authenticate,sessionFromRequest,sessionCookie,clearCookie,createToken,verifyToken};
}

module.exports={createUiAuth,safeEqual,cookieMap};
