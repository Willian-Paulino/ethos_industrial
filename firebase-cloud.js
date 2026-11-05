/* ETHOS Industrial — Firebase Spark (sem Cloud Functions). Dados via Firestore com regras de segurança.
 * Compatibilidade com os painéis anteriores: intercepta SOMENTE as rotas internas /api/* e /logout.
 * Nunca coloque chaves privadas, contas de serviço ou dados de produção neste arquivo.
 */
(function(){
'use strict';
const config=window.ETHOS_FIREBASE_CONFIG;
if(!config || !config.apiKey || String(config.apiKey).includes('SUBSTITUIR') || !config.projectId || String(config.projectId).includes('SEU_PROJETO')){
  window.ethosCloudConfigError='Configure firebase-config.js com os dados PÚBLICOS do aplicativo Web Firebase.';
  return;
}
if(!firebase.apps.length)firebase.initializeApp(config);
const auth=firebase.auth(),db=firebase.firestore();
const now=()=>new Date().toISOString();
const roles=['admin','intermediate','common'];
const categories=['apontamento','cadastro','transferencia','estoque','sistema','outros'];
const priorities=['baixa','normal','alta','critica'];
const statuses=['pending','approved','resolved'];
const DEFAULT_SLA={baixa:{response:24,resolution:96},normal:{response:8,resolution:48},alta:{response:4,resolution:24},critica:{response:1,resolution:8}};
const fail=(msg,status=400)=>Object.assign(new Error(msg),{status});
const cache=new Map();
let userPromise=new Promise(resolve=>auth.onAuthStateChanged(resolve,()=>resolve(null)));
let currentProfile=null;
async function user(){return await userPromise;}
async function profile(){const u=await user();if(!u)throw fail('Sessão expirada. Entre novamente.',401);const snap=await db.collection('users').doc(u.uid).get();if(!snap.exists)throw fail('Cadastro ainda não concluído.',403);const p={uid:u.uid,...snap.data()};if(!p.active||p.approval_status!=='approved'||!roles.includes(p.role))throw fail('Cadastro pendente de aprovação ou desativado.',403);currentProfile=p;return p;}
async function permitted(...allowed){const p=await profile();if(!allowed.includes(p.role))throw fail('Você não tem permissão para esta operação.',403);return p;}
const normalize=v=>String(v||'').trim().toLowerCase();
function id(){return String(Date.now()*1000+Math.floor(Math.random()*1000));} // inteiro seguro JS, ordenável e praticamente único
const b64FromBytes=bytes=>{let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const bytesFromB64=s=>{const bin=atob(s),arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);return arr;};
const sha256=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
function checkSize(data,max){const bytes=new TextEncoder().encode(JSON.stringify(data));if(bytes.length>max)throw fail('Dados excedem o limite de tamanho da base ('+Math.round(max/1048576)+' MiB).',413);return bytes;}
async function readKind(kind,fallback){
 const ref=db.collection('app_state').doc(kind),meta=await ref.get();
 if(!meta.exists)return {revision:0,data:fallback,updated_at:null,updated_by:null};
 const m=meta.data(),revision=Number(m.revision||0),cached=cache.get(kind);
 if(cached&&cached.revision===revision&&cached.version===m.version)return cached.result;
 if(!m.version)return {revision,data:fallback,updated_at:m.updated_at||null,updated_by:m.updated_by||null};
 if(!Number.isSafeInteger(m.count)||m.count<1||m.count>150)throw fail('Manifesto do Firestore inválido.',500);
 const snap=await ref.collection('versions').doc(m.version).collection('chunks').orderBy('i').get();
 if(snap.size!==m.count)throw fail('Base incompleta: fragmentos não encontrados. Atualize a página.',503);
 const parts=snap.docs.map(d=>bytesFromB64(d.data().payload||''));
 const bytes=new Uint8Array(parts.reduce((sum,b)=>sum+b.length,0));let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
 if(bytes.length!==m.size||(await sha256(bytes))!==m.sha256)throw fail('Verificação de integridade falhou. Nenhum dado foi alterado.',503);
 const result={revision,data:JSON.parse(new TextDecoder().decode(bytes)),updated_at:m.updated_at||null,updated_by:m.updated_by||null};
 cache.set(kind,{revision,version:m.version,result});return result;
}
async function writeKind(kind,data,revision){
 const p=await permitted('admin','intermediate');
 if(['ops','movements','dataset'].includes(kind)&&p.role!=='admin')throw fail('Somente administradores podem substituir esta base.',403);
 if(!['dataset','pcp','ops','movements'].includes(kind))throw fail('Base não reconhecida.');
 if(!Number.isSafeInteger(revision)||revision<0)throw fail('Revisão inválida.');
 const bytes=checkSize(data,16*1024*1024),hash=await sha256(bytes),version=crypto.randomUUID(),count=Math.ceil(bytes.length/(160*1024));
 if(count>150)throw fail('Muitos fragmentos para uma única base.',413);
 const ref=db.collection('app_state').doc(kind),col=ref.collection('versions').doc(version).collection('chunks');
 for(let start=0;start<count;start+=20){const batch=db.batch();for(let i=start;i<Math.min(start+20,count);i++)batch.set(col.doc(String(i).padStart(5,'0')),{i,payload:b64FromBytes(bytes.subarray(i*160*1024,(i+1)*160*1024)),writer_uid:p.uid});await batch.commit();}
 const stamp=now();
 const result=await db.runTransaction(async tx=>{
  const snap=await tx.get(ref),current=snap.exists?Number(snap.data().revision||0):0;
  if(current!==revision)throw fail('Outro usuário alterou a base. Recarregue antes de salvar.',409);
  tx.set(ref,{version,count,size:bytes.length,sha256:hash,revision:current+1,updated_at:stamp,updated_by:p.username,updated_uid:p.uid});
  return {ok:true,revision:current+1,updated_at:stamp,updatedBy:p.username};
 });
 cache.delete(kind);return result;
}
async function extras(){const s=await db.collection('implant_entries').limit(10000).get();return s.docs.map(d=>({...d.data().row,_ethosId:d.id})).sort((a,b)=>String(a._ethosId).localeCompare(String(b._ethosId)));}
async function state(){
 await permitted('admin','intermediate');const m=await readKind('dataset',{imported:null,added:[],actions:{}});
 if(cache.get('mergedState')?.revision===m.revision)return cache.get('mergedState').value;
 const extra=await extras();const d=m.data||{};
 const value={revision:m.revision,imported:d.imported??null,added:[...(d.added||[]),...extra],actions:d.actions||{},updatedAt:m.updated_at,updatedBy:m.updated_by};
 cache.set('mergedState',{revision:m.revision,value});return value;
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function bumpDataset(revision,p){
 const ref=db.collection('app_state').doc('dataset');
 const out=await db.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists)throw fail('Importe primeiro a base inicial do ETHOS.',409);const m=snap.data();if(m.revision!==revision)throw fail('Outro usuário atualizou a base.',409);tx.update(ref,{revision:revision+1,updated_at:now(),updated_by:p.username,updated_uid:p.uid});return {ok:true,revision:revision+1};});
 cache.delete('dataset');cache.delete('mergedState');return out;
}
async function saveState(input){
 const p=await permitted('admin','intermediate');
 if(!input||!Number.isSafeInteger(input.revision)||!Array.isArray(input.added)||!input.actions||typeof input.actions!=='object'||(input.imported!==null&&!Array.isArray(input.imported)))throw fail('Dados inválidos.');
 if(input.added.length>30000||(input.imported?.length||0)>80000)throw fail('Base grande demais.',413);
 const old=await state();if(old.revision!==input.revision)throw fail('Outro usuário atualizou a base. Recarregue.',409);
 if(p.role==='intermediate'){
  if(!equal(old.imported,input.imported)||!equal(old.actions,input.actions)||input.added.length<=old.added.length||!equal(input.added.slice(0,old.added.length),old.added))throw fail('Intermediário só pode acrescentar implantações.',403);
  const newRows=input.added.slice(old.added.length);if(newRows.length>200)throw fail('Importe no máximo 200 registros por vez.',413);
  const batch=db.batch();for(const row of newRows){const ref=db.collection('implant_entries').doc();batch.set(ref,{row,created_by_uid:p.uid,created_at:now()});}await batch.commit();
  return await bumpDataset(input.revision,p);
 }
 // Os registros criados por intermediários ficam em documentos separados, protegidos por regras.
 const cloudRows=input.added.filter(r=>r&&r._ethosId),baseRows=input.added.filter(r=>!r||!r._ethosId);
 const result=await writeKind('dataset',{imported:input.imported,added:baseRows,actions:input.actions},input.revision);
 // Administrador pode editar ou remover implantações extras. Não apaga sem solicitação explícita.
 const oldIds=new Set(old.added.filter(r=>r._ethosId).map(r=>r._ethosId));
 const wanted=new Set(cloudRows.map(r=>r._ethosId));
 const batch=db.batch();let changed=0;
 for(const r of cloudRows){const row={...r};delete row._ethosId;batch.set(db.collection('implant_entries').doc(r._ethosId),{row,created_by_uid:p.uid,created_at:now()},{merge:true});changed++;}
 for(const oid of oldIds)if(!wanted.has(oid)){batch.delete(db.collection('implant_entries').doc(oid));changed++;}
 if(changed)await batch.commit();
 await db.collection('dataset_audit').add({revision:result.revision,username:p.username,created_at:now(),base_count:input.imported?.length||0,manual_count:input.added.length,actions_count:Object.keys(input.actions).length,actor_uid:p.uid}).catch(()=>{});
 cache.delete('mergedState');return result;
}
async function listUsers(){await permitted('admin');const s=await db.collection('users').limit(3000).get();return {users:s.docs.map(d=>({uid:d.id,...d.data()})).sort((a,b)=>(a.approval_status!=='pending')-(b.approval_status!=='pending')||a.username.localeCompare(b.username))};}
async function audit(operation,target){try{const p=await profile();await db.collection('user_audit').add({actor:p.username,actor_uid:p.uid,role:p.role,operation,target,created_at:now()});}catch(e){console.warn('Auditoria:',e.message)}}
async function manageUser(a){const p=await permitted('admin'),name=normalize(a.username),ref=db.collection('usernames').doc(name),nameSnap=await ref.get();
 if(a.action==='create')throw fail('No plano gratuito, peça ao colaborador para usar Solicitar cadastro. O administrador aprova depois.',501);
 if(a.action==='reset_password')throw fail('Redefinição de senha: use Firebase Authentication (conta com e-mail real) ou o utilitário administrativo local.',501);
 if(!nameSnap.exists)throw fail('Usuário não encontrado.',404);const uid=nameSnap.data().uid,target=db.collection('users').doc(uid),snap=await target.get();if(!snap.exists)throw fail('Perfil não encontrado.',404);
 const u=snap.data();if(a.action==='approve'){
  if(u.approval_status!=='pending')throw fail('Cadastro não está pendente.');if(!['common','intermediate'].includes(a.role))throw fail('Aprovação para administrador exige utilitário local autorizado.');
  await target.update({role:a.role,active:true,approval_status:'approved'});
 }else if(a.action==='reject'){
  if(u.approval_status!=='pending')throw fail('Somente cadastros pendentes podem ser recusados.');const batch=db.batch();batch.delete(target);batch.delete(ref);await batch.commit();
 }else if(a.action==='set_role'){
  if(uid===p.uid)throw fail('Não altere seu próprio perfil.');if(u.role==='admin'||!['common','intermediate'].includes(a.role))throw fail('Mudanças envolvendo administradores exigem utilitário local.');await target.update({role:a.role});
 }else if(a.action==='set_active'){
  if(uid===p.uid)throw fail('Você não pode desativar sua própria conta.');if(u.role==='admin')throw fail('Alterações em administradores exigem utilitário local.');await target.update({active:!!a.active,...(a.active?{approval_status:'approved'}:{})});
 }else throw fail('Ação não suportada.');
 await audit('user_'+a.action,name);return {ok:true};
}
async function notify(uid,requestId,message){const p=await profile();const nid=id();await db.collection('internal_notifications').doc(nid).set({id:Number(nid),user_uid:uid,request_id:requestId,message:String(message).slice(0,400),created_at:now(),read_at:null,sender_uid:p.uid});}
async function notifyAdmins(requestId,message){const snap=await db.collection('settings').doc('admin_contacts').get();const uids=Array.isArray(snap.data()?.uids)?snap.data().uids:[];await Promise.all(uids.slice(0,20).map(uid=>notify(uid,requestId,message).catch(e=>console.warn('Notificação:',e.message))));}
async function notifications(){const p=await permitted('admin','common');const s=await db.collection('internal_notifications').where('user_uid','==',p.uid).limit(500).get();const rows=s.docs.map(d=>d.data()).sort((a,b)=>b.id-a.id);return {notifications:rows.slice(0,80).map(({user_uid,sender_uid,...rest})=>rest),unread:rows.filter(x=>!x.read_at).length};}
async function readNotification(input){const p=await permitted('admin','common');if(input.action!=='read')throw fail('Ação inválida.');const ref=db.collection('internal_notifications').doc(String(input.id)),snap=await ref.get();if(!snap.exists||snap.data().user_uid!==p.uid)throw fail('Notificação não encontrada.',404);await ref.update({read_at:now()});return {ok:true};}
async function listHelp(){const p=await permitted('admin','common');const col=db.collection('help_requests');const s=p.role==='admin'?await col.orderBy('id','desc').limit(150).get():await col.where('user_uid','==',p.uid).limit(150).get();const rows=s.docs.map(d=>d.data()).sort((a,b)=>(a.status==='resolved')-(b.status==='resolved')||b.id-a.id);
 for(let start=0;start<rows.length;start+=12)await Promise.all(rows.slice(start,start+12).map(async r=>{if(!r.message_count){r.messages=[];return;}const ms=await col.doc(String(r.id)).collection('messages').orderBy('id').limit(100).get();r.messages=ms.docs.map(d=>d.data());}));return {requests:rows};}
async function help(a){const p=await permitted('admin','common');
 if(a.action==='create'){
  if(p.role!=='common')throw fail('Somente o perfil comum abre solicitações.',403);
  const itemType=String(a.itemType||''),itemCode=String(a.itemCode||'').trim(),description=String(a.description||'').trim(),category=String(a.category||'apontamento'),priority=String(a.priority||'normal'),sector=String(a.sector||'').trim();
  if(!['cliente','ethos'].includes(itemType)||itemCode.length<2||itemCode.length>100||description.length<10||description.length>3000||!categories.includes(category)||!priorities.includes(priority)||sector.length>80)throw fail('Confira código, categoria, prioridade, setor e descrição.');
  const tid=id(),stamp=now(),record={id:Number(tid),user_uid:p.uid,username:p.username,item_type:itemType,item_code:itemCode,description,status:'pending',admin_reply:'',category,priority,sector,assigned_to:'',due_at:null,resolved_at:null,first_response_at:null,created_at:stamp,updated_at:stamp,handled_by:null,message_count:0};
  await db.collection('help_requests').doc(tid).set(record);await notifyAdmins(record.id,`Nova solicitação #${tid} de ${p.username}: ${itemCode} (${priority})`);await audit('help_create','#'+tid);return {ok:true,id:record.id};
 }
 const tid=String(a.id),ref=db.collection('help_requests').doc(tid),snap=await ref.get();if(!snap.exists)throw fail('Solicitação não encontrada.',404);const ticket=snap.data();if(p.role!=='admin'&&ticket.user_uid!==p.uid)throw fail('Sem acesso a esta solicitação.',403);
 if(a.action==='message'){
  const body=String(a.body||'').trim();if(body.length<2||body.length>3000)throw fail('Mensagem deve ter de 2 a 3000 caracteres.');if(p.role==='common'&&ticket.status==='resolved')throw fail('Chamado concluído.',409);
  const mid=id(),stamp=now();await db.runTransaction(async tx=>{const latest=await tx.get(ref);if(!latest.exists)throw fail('Chamado não encontrado.',404);tx.set(ref.collection('messages').doc(mid),{id:Number(mid),request_id:Number(tid),user_uid:p.uid,author:p.username,body,created_at:stamp});tx.update(ref,{updated_at:stamp,message_count:firebase.firestore.FieldValue.increment(1),...(p.role==='admin'&&!latest.data().first_response_at?{first_response_at:stamp}:{})});});
  if(p.role==='admin')await notify(ticket.user_uid,ticket.id,`Nova resposta do PCP no chamado #${tid}`);else await notifyAdmins(ticket.id,`Nova mensagem de ${p.username} no chamado #${tid}`);
  await audit('help_message','#'+tid);return {ok:true};
 }
 if(a.action==='update'){
  if(p.role!=='admin')throw fail('Sem permissão.',403);const status=String(a.status||''),reply=String(a.reply||'').trim(),priority=String(a.priority||'normal'),assigned=String(a.assignedTo||'').trim(),due=String(a.dueAt||'').trim();
  if(!statuses.includes(status)||!priorities.includes(priority)||reply.length>3000||assigned.length>80||(due&&!/^\d{4}-\d{2}-\d{2}$/.test(due)))throw fail('Dados inválidos.');if(status==='resolved'&&reply.length<3)throw fail('Informe uma orientação para concluir.');
  const stamp=now(),updates={status,admin_reply:reply,priority,assigned_to:assigned,due_at:due||null,resolved_at:status==='resolved'?(ticket.resolved_at||stamp):null,updated_at:stamp,handled_by:p.username};if(reply&&!ticket.first_response_at)updates.first_response_at=stamp;
  await ref.update(updates);await ref.collection('events').doc(id()).set({request_id:Number(tid),actor:p.username,action:'status_changed',status,reply,created_at:stamp});
  if(ticket.status!==status||ticket.admin_reply!==reply)await notify(ticket.user_uid,ticket.id,`Chamado #${tid} atualizado pelo PCP: ${status}`);await audit('help_update','#'+tid);return {ok:true};
 }
 throw fail('Ação desconhecida.');
}
function validPolicy(p){return p&&typeof p==='object'&&priorities.every(k=>p[k]&&Number.isInteger(p[k].response)&&Number.isInteger(p[k].resolution)&&p[k].response>=1&&p[k].resolution<=720&&p[k].response<=p[k].resolution);}
function slaMetrics(rows,policy,period){
 const nowMs=Date.now(),totals={total:rows.length,open:0,resolved:0,overdue:0,responseBreached:0,resolutionBreached:0,responseEligible:0,resolutionEligible:0,responseOnTime:0,resolutionOnTime:0,responded:0,firstResponseHours:null,resolutionHours:null};
 let respSum=0,resSum=0;const breakdown={priority:{},category:{},sector:{},assigned_to:{}};
 for(const r of rows){const created=Date.parse(r.created_at),first=r.first_response_at?Date.parse(r.first_response_at):NaN,resolved=r.resolved_at?Date.parse(r.resolved_at):NaN;if(!Number.isFinite(created))continue;const sl=policy[r.priority]||policy.normal,responseDeadline=created+sl.response*3600000,resolutionDeadline=created+sl.resolution*3600000,hasFirst=Number.isFinite(first),hasResolved=r.status==='resolved'&&Number.isFinite(resolved),responseEligible=hasFirst||nowMs>responseDeadline,resolutionEligible=hasResolved||nowMs>resolutionDeadline,responseBreached=responseEligible&&(hasFirst?first>responseDeadline:nowMs>responseDeadline),resolutionBreached=resolutionEligible&&(hasResolved?resolved>resolutionDeadline:nowMs>resolutionDeadline);
 if(r.status==='resolved')totals.resolved++;else totals.open++;if(!hasResolved&&nowMs>resolutionDeadline)totals.overdue++;if(hasFirst){totals.responded++;respSum+=Math.max(0,first-created)/3600000;}if(hasResolved)resSum+=Math.max(0,resolved-created)/3600000;if(responseEligible){totals.responseEligible++;if(!responseBreached)totals.responseOnTime++;}if(resolutionEligible){totals.resolutionEligible++;if(!resolutionBreached)totals.resolutionOnTime++;}if(responseBreached)totals.responseBreached++;if(resolutionBreached)totals.resolutionBreached++;
 for(const field of Object.keys(breakdown)){const key=String(r[field]||'Não informado').trim().slice(0,80)||'Não informado',entry=breakdown[field][key]||(breakdown[field][key]={name:key,total:0,resolved:0,late:0,responded:0,responseBreached:0,resolutionBreached:0});entry.total++;if(hasResolved)entry.resolved++;if(!hasResolved&&nowMs>resolutionDeadline)entry.late++;if(hasFirst)entry.responded++;if(responseBreached)entry.responseBreached++;if(resolutionBreached)entry.resolutionBreached++;}
 }
 totals.firstResponseHours=totals.responded?Math.round(respSum/totals.responded*10)/10:null;const resolvedWithTime=rows.filter(r=>r.status==='resolved'&&r.resolved_at&&Number.isFinite(Date.parse(r.resolved_at))).length;totals.resolutionHours=resolvedWithTime?Math.round(resSum/resolvedWithTime*10)/10:null;const sorted={};for(const [field,groups] of Object.entries(breakdown))sorted[field]=Object.values(groups).sort((a,b)=>b.total-a.total).slice(0,12);return {period,policy,totals,breakdown:sorted,generatedAt:now()};
}
async function sla(period){await permitted('admin');if(!['7','30','90','all'].includes(period))throw fail('Período inválido.');const s=await db.collection('help_requests').orderBy('id','desc').limit(1000).get(),rows=s.docs.map(d=>d.data()).filter(r=>period==='all'||Date.parse(r.created_at)>=Date.now()-Number(period)*86400000);const p=await db.collection('settings').doc('sla').get();return slaMetrics(rows,p.exists?p.data().policy:DEFAULT_SLA,period);}
async function slaSettings(a){const p=await permitted('admin');if(!validPolicy(a.policy))throw fail('Informe prazos válidos de 1 a 720 horas.');await db.collection('settings').doc('sla').set({policy:a.policy,updated_at:now(),updated_by:p.username});await audit('sla_policy_update','metas SLA');return {ok:true,policy:a.policy};}
async function audits(kind){await permitted('admin');const s=await db.collection(kind).orderBy('created_at','desc').limit(kind==='user_audit'?1000:100).get();return {events:s.docs.map(d=>({id:d.id,...d.data()}))};}
async function route(path,method,body){
 const url=new URL(path,location.href),pathname=url.pathname.replace(/\/+$/,'');
 if(pathname==='/logout'){await auth.signOut();return {ok:true};}
 if(pathname==='/api/health'){const p=await profile();return {ok:true,database:'firestore',user:p.username,role:p.role};}
 if(pathname==='/api/state')return method==='POST'?saveState(body):state();
 if(pathname==='/api/pcp/state')return method==='POST'?(await writeKind('pcp',body.data,body.revision)):readKind('pcp',null);
 if(pathname==='/api/help')return method==='POST'?help(body):listHelp();
 if(pathname==='/api/notifications')return method==='POST'?readNotification(body):notifications();
 if(pathname==='/api/users')return method==='POST'?manageUser(body):listUsers();
 if(pathname==='/api/audit')return audits('dataset_audit');
 if(pathname==='/api/admin-audit')return audits('user_audit');
 if(pathname==='/api/admin/firebase-status'){await permitted('admin');return {enabled:true,connected:true,pending:0,failed:0,last_success:now(),mode:'GitHub Pages + Firestore (Spark). Sem SQLite ou Cloud Functions.'};}
 if(pathname==='/api/sla/metrics')return sla(url.searchParams.get('period')||'30');
 if(pathname==='/api/sla/settings')return slaSettings(body);
 throw fail('Rota não disponível no modo Firebase Spark.',404);
}
const nativeFetch=window.fetch.bind(window);
window.fetch=async function(resource,opts={}){
 const value=typeof resource==='string'?resource:(resource instanceof URL?resource.href:resource?.url||''),url=new URL(value,location.href);
 const isAPI=(url.origin===location.origin)&&(url.pathname.startsWith('/api/')||url.pathname==='/logout');
 if(!isAPI)return nativeFetch(resource,opts);
 const method=String(opts.method||'GET').toUpperCase();
 try{const body=opts.body?JSON.parse(opts.body):{};const data=await route(url.href,method,body);return new Response(JSON.stringify(data),{status:method==='POST'?200:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}
 catch(e){const status=e.status||(e.code==='permission-denied'?403:e.code==='unavailable'?503:500);console.error('ETHOS Firebase:',e);return new Response(JSON.stringify({error:e.message||'Falha de conexão ao Firebase.'}),{status,headers:{'Content-Type':'application/json'}});}
};
window.ethosCloud={auth,db,user,profile,readKind,writeKind,getState:state,getRole:async()=> (await profile()).role,signOut:()=>auth.signOut()};
})();
