import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { buildCockpit, cockpitLayoutCSS } from './weda-admin-cockpit.mjs';
import { connectCockpit } from './connect-weda-cockpit.mjs';

const root = resolve(import.meta.dirname, '..');
const appId = 'app-pq2auygx';
const applicationPath = resolve(root, 'weda-admin/app.cals.json');
let app;
let baseline;
try {
  // The checked-in application is the current source of its five other pages,
  // layout templates and configuration. Rebuilding needs no output/ backup.
  app = JSON.parse(await readFile(applicationPath, 'utf8'));
  baseline = { appId, historyId: null, source: 'weda-admin/app.cals.json' };
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  baseline = JSON.parse(await readFile(resolve(root, 'output/weda-admin-redesign-baseline.json'), 'utf8'));
  if (baseline.appId !== appId) throw new Error('Unexpected design baseline application');
  app = JSON.parse(await readFile(baseline.backupPath, 'utf8'));
  baseline.source = baseline.backupPath;
}
if (app.name !== 'hl-admin-weda' || app.schemaVersion !== '4.0.0' || (app.appId && app.appId !== appId)) throw new Error('Unexpected design baseline');
const preserved = structuredClone({ pages: app.items.filter(page => page.id !== 'overview'), templates: app.templates, extra: app.extra });
const C = { bg:'#F7F3EC', card:'#FFFDF9', ink:'#2F2924', primary:'#A35D45', muted:'#736256', border:'#E7DED3', soft:'#F1E5DC' };
const font = '"PingFang SC", "Microsoft YaHei", sans-serif';
const pages = [
  { id:'overview', title:'运营总览', subtitle:'会员规模、主理人运营与经营收款，一屏掌握。', icon:'dashboard' },
  { id:'matchmakers', title:'主理人审核', subtitle:'核对入驻申请，让每一次服务都有可靠的开始。', icon:'members', columns:['主理人','编号','所属城市','会员数','申请时间','认证状态','操作'], placeholder:'搜索姓名、编号或城市', actions:['查看资料','审核通过','拒绝申请'], empty:'主理人申请将在这里集中展示。' },
  { id:'certifications', title:'会员认证', subtitle:'核验申请与证明材料，清晰记录每次审核。', icon:'mine', columns:['会员','认证类型','申请编号','申请时间','审核状态','操作'], placeholder:'搜索会员或申请编号', actions:['查看材料','认证通过','拒绝认证'], empty:'会员认证申请将在这里集中展示。' },
  { id:'salons', title:'沙龙管理', subtitle:'从申请到举办，有序跟进每一场相遇。', icon:'salon', columns:['沙龙名称','主理人','城市','举办时间','报名人数','状态','操作'], placeholder:'搜索沙龙、主理人或城市', actions:['查看沙龙','审核通过','拒绝申请','取消沙龙'], empty:'沙龙申请、报名与举办状态将在这里展示。' },
  { id:'plans', title:'套餐管理', subtitle:'统一查看会员服务、价格与有效期。', icon:'dashboard', columns:['套餐名称','套餐编号','价格（元）','有效期','状态','更新时间','操作'], placeholder:'搜索套餐名称或编号', actions:['查看套餐','调整价格','启用 / 停用'], empty:'会员套餐与服务权益将在这里展示。', note:'当前仅查看套餐；价格和启停操作尚未开放。' },
  { id:'orders', title:'支付订单', subtitle:'核对支付与权益履约，让每笔服务有据可查。', icon:'messages', columns:['商户订单号','会员','套餐','实付金额（元）','支付状态','履约状态','创建时间'], placeholder:'搜索订单号、会员或套餐', actions:['查看订单详情'], empty:'支付订单与权益履约状态将在这里展示。', note:'本页提供订单查询与详情，不提供退款或手工履约。' }
];
const icons = Object.fromEntries(await Promise.all(['dashboard','members','mine','salon','messages'].map(async name => [name, 'data:image/png;base64,' + (await readFile(resolve(root,`miniprogram/assets/navigation/${name}-active.png`))).toString('base64')])));
const node = (id, component, attributes, items) => ({ id, component, attributes, ...(items ? {items} : {}) });
const box = (id, items, style = {}, cls = '') => node(id,'Container',{class:cls,style:{boxSizing:'border-box',display:'flex',flexDirection:'column',minWidth:'0px',...style}},items);
const txt = (id, text, style = {}, cls = '') => node(id,'WdText',{text,class:cls,overflow:false,userSelect:true,style:{display:'block',margin:'0px',padding:'0px',fontFamily:font,fontSize:'14px',lineHeight:'24px',color:C.ink,wordBreak:'break-word',...style}});
const title = (id,text) => txt(id,text,{fontSize:'18px',lineHeight:'28px',fontWeight:700});
const note = (id,text,style={}) => txt(id,text,{fontSize:'13px',lineHeight:'22px',color:C.muted,...style});
const icon = (id,name) => box(id,[],{width:'42px',height:'42px',flexShrink:0,borderRadius:'10px',backgroundColor:C.soft,backgroundImage:`url("${icons[name]}")`,backgroundSize:'25px 25px',backgroundPosition:'center',backgroundRepeat:'no-repeat'},'hl-icon');
const card = (id,items,style={},cls='') => box(id,items,{padding:'24px',border:`1px solid ${C.border}`,borderRadius:'10px',backgroundColor:C.card,...style},`hl-card ${cls}`.trim());
function button(id,text,{pageId,primary=false,danger=false}={}) {
  const b=node(id,'WdButton',{text,theme:danger?'error':primary?'primary':'secondary',variant:primary?'base':'outline',size:'md',formType:'button',disabled:!pageId,class:`hl-button ${primary?'hl-primary':danger?'hl-danger':'hl-secondary'}`,style:{fontFamily:font,fontSize:'14px',fontWeight:600,lineHeight:'22px',minHeight:'42px',height:'auto',padding:'9px 16px',borderRadius:'8px',boxSizing:'border-box',border:`1px solid ${primary?C.primary:C.border}`,backgroundColor:primary?C.primary:C.card,color:primary?'#FFF8ED':danger?'#963B35':C.primary,whiteSpace:'normal'}});
  if(pageId)b.listeners=[{id:`goto${pageId}`,eventName:'tap',type:'platform',handler:{name:'navigateTo',module:'platform',params:{mode:'weDa',packageName:'',pageId,params:{}}}}];
  return b;
}
function header(page) {
  return box('pageHeading',[
    note('eyebrow',page.id==='overview'?'HL / 运营工作台':'运营工作台 / '+page.title,{fontSize:'12px',fontWeight:600,letterSpacing:'1px',color:C.primary}),
    txt('pageTitle',page.title,{fontSize:'30px',fontWeight:800,lineHeight:'42px',marginTop:'6px'}),
    note('pageDescription',page.subtitle,{fontSize:'14px',lineHeight:'24px',marginTop:'4px'})
  ],{marginBottom:'24px'},'hl-page-heading');
}
function overview() {
  return buildCockpit({box,txt,note,title,card,node,button,icon,pages,C});
}
function listing(page) {
  const field=(id,label,placeholder,grow)=>box(id,[note(`${id}Label`,label,{fontSize:'12px',fontWeight:600,marginBottom:'6px'}),node(`${id}Input`,'WdInput',{name:id,placeholder,status:'disabled',labelVisible:false,template:'inputBox',class:'hl-input',style:{width:'100%',fontFamily:font,fontSize:'14px',lineHeight:'24px',minHeight:'42px',backgroundColor:C.card,borderRadius:'8px'}})],{flex:grow?'1 1 260px':'0 1 180px',minWidth:'150px'},grow?'hl-search-field':'hl-status-field');
  return [
    box('connectionNotice',[note('connectionNoticeCopy','界面预览 · 业务数据尚未接入，查询与审核操作暂不可用。',{fontSize:'13px',lineHeight:'22px',color:'#874A37'})],{padding:'12px 16px',border:`1px solid ${C.border}`,borderRadius:'8px',backgroundColor:C.soft,marginBottom:'20px'}),
    card('listCard',[
      box('filters',[field('status','状态筛选','全部状态',false),field('keyword','关键词',page.placeholder,true),box('filterActions',[button('queryButton','查询',{primary:true}),button('refreshButton','重置')],{flexDirection:'row',gap:'10px',alignItems:'center',flexWrap:'wrap'})],{flexDirection:'row',gap:'16px',alignItems:'flex-end',flexWrap:'wrap',paddingBottom:'24px'}),
      box('tableScroll',[
        box('tableHeader',page.columns.map((label,i)=>box(`column${i}`,[txt(`columnLabel${i}`,label,{fontSize:'13px',fontWeight:600,lineHeight:'22px',whiteSpace:'nowrap',color:'#6D5644'})],{padding:'14px 12px'})),{display:'grid',gridTemplateColumns:`repeat(${page.columns.length}, minmax(100px, 1fr))`,minWidth:'760px',backgroundColor:'#F4EDE4',borderTop:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`})
      ],{overflowX:'auto',maxWidth:'100%',borderRadius:'6px 6px 0px 0px'}),
      box('emptyRecords',[
        icon('emptyIcon',page.icon),
        txt('emptyTitle','等待加载记录',{fontSize:'16px',fontWeight:600,lineHeight:'28px',marginTop:'16px'}),
        note('emptyDescription',page.empty,{fontSize:'13px',lineHeight:'22px',textAlign:'center',marginTop:'6px',maxWidth:'340px'})
      ],{alignItems:'center',justifyContent:'center',padding:'44px 20px',minHeight:'250px',borderBottom:`1px solid ${C.border}`}),
      box('tableFooter',[note('recordCount','记录数 —',{fontSize:'12px',lineHeight:'22px'}),note('paginationPending','数据接入后启用分页',{fontSize:'12px',lineHeight:'22px'})],{flexDirection:'row',justifyContent:'space-between',gap:'12px',flexWrap:'wrap',paddingTop:'18px'})
    ],{marginBottom:'20px'},'hl-list-card'),
    card('operationPanel',[
      box('operationCopy',[title('operationHeading',page.id==='orders'?'订单详情':'记录处理'),note('operationNote',page.note||'选择一条记录后，可查看资料并进行处理。',{marginTop:'4px'})],{flex:'1 1 280px'}),
      box('operationButtons',page.actions.map((label,i)=>button(`operation${i}`,label,{primary:i===1&&page.id!=='plans',danger:/拒绝|取消/.test(label)})),{flexDirection:'row',gap:'10px',flexWrap:'wrap'})
    ],{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:'20px'})
  ];
}
app.items=pages.map(p=>{
  const old=app.items.find(x=>x.id===p.id);
  if (!old) throw new Error('Missing existing page '+p.id);
  // Preserve the other five cloud pages during a cockpit-only update.
  if (p.id !== 'overview' && !process.argv.includes('--all-pages')) return old;
  const menu=node('adminMenu','WdMenuLayout',{
    ...old.items[0].attributes,
    class:'hl-admin',
    style:{backgroundColor:C.bg,minHeight:'100vh',fontFamily:font,color:C.ink},
    menu:{...old.items[0].attributes.menu,menuData:pages.map((x,i)=>({title:x.title,key:x.id,iconUrl:['td:dashboard','td:usergroup','td:secured','td:calendar','td:gift','td:creditcard'][i],type:'route',path:`/${x.id}`,visible:true,disabled:false})),mobileMenuData:[]},
    selectedMenuKey:p.id
  },[
    {id:'headSlot',items:[box('brand',[txt('brandMark','HL',{fontSize:'19px',fontWeight:800,lineHeight:'38px',color:'#FFF8ED',backgroundColor:C.primary,borderRadius:'8px',width:'40px',height:'38px',textAlign:'center',flexShrink:0}),box('brandCopy',[txt('brandName','运营管理',{fontSize:'17px',fontWeight:700,lineHeight:'25px'}),note('brandSubtitle','HL 婚恋服务',{fontSize:'10px',lineHeight:'17px',letterSpacing:'1px'})])],{flexDirection:'row',alignItems:'center',gap:'10px',width:'100%',minHeight:'52px'},'hl-brand')]},
    {id:'headRightSlot',items:[note('draftStatus','界面预览',{fontSize:'12px',lineHeight:'22px',color:C.primary,whiteSpace:'nowrap'})]},
    {id:'contentSlot',items:[box('pageContent',[header(p),...(p.id==='overview'?overview():listing(p)),note('pageFooter','HL 婚恋服务 · 运营管理工作台',{fontSize:'11px',lineHeight:'20px',marginTop:'28px',color:'#8F7C6C'})],{padding:'32px',width:'100%',maxWidth:'1440px',minHeight:'100vh',backgroundColor:C.bg},'hl-page-content')]},
    {id:'footerSlot',items:[note('draftFooter','HL 婚恋服务',{fontSize:'11px',lineHeight:'20px',color:'#8F7C6C',padding:'12px 10px'})]}
  ]);
  return {...old,label:p.title,items:[menu]};
});
app.resources=app.resources.filter(x=>!(x.name==='style'&&x.codeType==='style'));
app.resources.push({type:'CODE',name:'style',path:'global/style',codeType:'style',code:(await readFile(resolve(root,'weda-admin/theme.css'),'utf8')).trimEnd()+'\n\n'+cockpitLayoutCSS.trim()+'\n'});
app.description='与小程序品牌一致的运营驾驶舱；经授权的只读会员、主理人和经营收款统计，其他业务操作待接入。';
// Rebuilding the view must also restore its reviewed variables, bindings and
// lifecycle, rather than silently reverting a connected dashboard to a draft.
const connectedApp = connectCockpit(app, await readFile(resolve(root, 'weda-admin/cockpit-runtime.js'), 'utf8'));
if (!process.argv.includes('--all-pages') && !isDeepStrictEqual(connectedApp.items.filter(page => page.id !== 'overview'), preserved.pages)) throw new Error('Unexpected changes to other five pages');
if (!isDeepStrictEqual(connectedApp.templates, preserved.templates) || !isDeepStrictEqual(connectedApp.extra, preserved.extra)) throw new Error('Unexpected application layout or configuration changes');
await writeFile(applicationPath,JSON.stringify(connectedApp,null,2)+'\n');
console.log(JSON.stringify({appId,pages:pages.map(p=>p.id),baselineSource:baseline.source,cloudBaseline:baseline.historyId,readOnlyFunction:'hlAdminCockpit',otherPagesPreserved:!process.argv.includes('--all-pages'),layoutTemplatesPreserved:true,output:'weda-admin/app.cals.json'}));
