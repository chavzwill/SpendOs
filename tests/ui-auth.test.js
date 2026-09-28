const test=require('node:test');
const assert=require('node:assert/strict');
const {createUiAuth}=require('../src/ui-auth');

test('local UI auth can run open without exposing a bearer key',()=>{
  const auth=createUiAuth({production:false});
  assert.equal(auth.enabled,false);
  assert.deepEqual(auth.sessionFromRequest({headers:{}}),{user:'local',mode:'open_local'});
});

test('production UI auth requires management password and strong session secret',()=>{
  assert.throws(()=>createUiAuth({production:true,password:'',secret:'x'.repeat(32)}),/SPENDOS_UI_PASSWORD/);
  assert.throws(()=>createUiAuth({production:true,password:'strong-password',secret:'short'}),/SPENDOS_SESSION_SECRET/);
});

test('signed management sessions authenticate and reject tampering',()=>{
  const auth=createUiAuth({
    production:true,
    username:'finance-admin',
    password:'correct horse battery staple',
    secret:'a-very-long-random-session-secret-value-123456789'
  });
  assert.equal(auth.authenticate('finance-admin','wrong'),null);
  const login=auth.authenticate('finance-admin','correct horse battery staple');
  assert.equal(login.user,'finance-admin');

  const token=auth.createToken(login.user,1_000);
  assert.equal(auth.verifyToken(token,2_000).user,'finance-admin');
  assert.equal(auth.verifyToken(token+'x',2_000),null);

  const cookie=auth.sessionCookie(login.user);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Strict/);
  assert.match(cookie,/Secure/);
});
