// Native Weda dashboard; every chart starts with an explicit empty dataset.
// This module defines the view only. Aggregates must come from a verified server API.
// Appended after the shared theme by the generator, without changing other pages.
export const cockpitLayoutCSS = `
/* Keep six KPI cards only where the desktop content area can fit money values. */
@media (max-width: 1599px) {
  .hl-admin #cockpitMetrics { grid-template-columns: repeat(3, minmax(0, 1fr)) !important; }
}
@media (max-width: 600px) {
  .hl-admin #cockpitMetrics { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
}
@media (max-width: 360px) {
  .hl-admin #cockpitMetrics { grid-template-columns: minmax(0, 1fr) !important; }
}
`;

export function buildCockpit({ box, txt, note, title, card, node, button, icon, pages, C }) {
  const pill = (id, text, selected = false) => txt(id, text, { fontSize:'12px', lineHeight:'22px', padding:'5px 12px', borderRadius:'18px', border:`1px solid ${C.border}`, backgroundColor:selected?C.soft:C.card, color:selected?C.primary:C.muted, whiteSpace:'nowrap' });
  const heading = (id, kicker, text, detail) => box(`${id}Heading`,[
    note(`${id}Kicker`,kicker,{fontSize:'10px',lineHeight:'18px',fontWeight:700,letterSpacing:'1.5px',color:C.primary}),
    title(`${id}Title`,text),
    ...(detail?[note(`${id}Detail`,detail,{fontSize:'12px',lineHeight:'20px',marginTop:'3px'})]:[])
  ]);
  const legend = (id, label, color) => box(id,[box(`${id}Dot`,[],{width:'7px',height:'7px',borderRadius:'50%',backgroundColor:color,flexShrink:0}),note(`${id}Label`,label,{fontSize:'12px',lineHeight:'20px'})],{flexDirection:'row',gap:'7px',alignItems:'center'});
  const plot = (id, emptyTitle, emptyCopy, legends) => box(`${id}Plot`,[
    box(`${id}Legend`,legends.map((x,i)=>legend(`${id}Legend${i}`,x[0],x[1])),{flexDirection:'row',gap:'20px',flexWrap:'wrap',marginTop:'16px'}),
    box(`${id}Canvas`,[
      node(`${id}Chart`,'Line',{chartType:'line',dataSourceType:'variable',datasourceVariable:[],isTitle:false,isLegend:false,isSeriesShowSymbol:false,isXaxisName:false,isXaxisAxisLabelShow:true,isXaxisAxisTickShow:false,isYAxisShow:true,isYAxisName:false,isYAxisSplitlineLinestyleWidth:true,yAxisSplitlineLinestyleType:'dashed',style:{width:'100%',height:'210px',backgroundColor:C.card}}),
      box(`${id}Empty`,[txt(`${id}EmptyTitle`,emptyTitle,{fontSize:'14px',lineHeight:'24px',fontWeight:600}),note(`${id}EmptyCopy`,emptyCopy,{fontSize:'12px',lineHeight:'20px',marginTop:'4px'})],{position:'absolute',inset:'0px',alignItems:'center',justifyContent:'center',textAlign:'center',padding:'24px',pointerEvents:'none'},'hl-chart-empty')
    ],{position:'relative',height:'210px',marginTop:'8px',overflow:'hidden'},'hl-chart-canvas'),
    box(`${id}Axis`,[note(`${id}AxisStart`,'近30天',{fontSize:'11px',lineHeight:'18px'}),note(`${id}AxisEnd`,'按日统计',{fontSize:'11px',lineHeight:'18px'})],{flexDirection:'row',justifyContent:'space-between',padding:'0px 8px'})
  ]);
  const metrics = [
    ['会员档案数','人','去重后的有效会员档案','MEMBERS'],
    ['新增会员','人','近30天首次建档','GROWTH'],
    ['认证主理人','人','当前审核通过','PARTNERS'],
    ['实付金额','元','近30天已核验收款','PAYMENTS'],
    ['退款金额','元','近30天已核验退款','REFUNDS'],
    ['净收款','元','实付金额 − 退款金额','NET CASH']
  ];
  const stateRow = (id,label,desc) => box(id,[box(`${id}Copy`,[txt(`${id}Label`,label,{fontSize:'13px',fontWeight:600,lineHeight:'24px'}),note(`${id}Description`,desc,{fontSize:'11px',lineHeight:'18px'})],{flex:'1 1 auto'}),txt(`${id}Value`,'—',{fontSize:'23px',fontWeight:700,lineHeight:'34px'})],{flexDirection:'row',alignItems:'center',gap:'12px',padding:'14px 0px',borderBottom:`1px solid ${C.border}`});
  return [
    box('cockpitToolbar',[
      box('cockpitContext',[pill('cockpitPeriod','统计周期 · 近30天',true),pill('cockpitScope','全部业务')],{flexDirection:'row',gap:'8px',flexWrap:'wrap'}),
      box('cockpitUpdate',[box('cockpitStatusDot',[],{width:'6px',height:'6px',borderRadius:'50%',backgroundColor:C.primary}),note('cockpitUpdateText','数据待接入 · 更新于 —',{fontSize:'12px',lineHeight:'20px'})],{flexDirection:'row',gap:'8px',alignItems:'center'})
    ],{flexDirection:'row',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:'12px',marginBottom:'20px'}),
    box('cockpitMetrics',metrics.map((m,i)=>card(`cockpitMetric${i}`,[
      note(`cockpitMetricKicker${i}`,m[3],{fontSize:'9px',lineHeight:'17px',letterSpacing:'1px',color:i===0?'#D9C4B2':C.primary}),
      txt(`cockpitMetricLabel${i}`,m[0],{fontSize:'13px',lineHeight:'24px',fontWeight:600,color:i===0?'#FFF8ED':C.ink,marginTop:'3px'}),
      box(`cockpitMetricNumber${i}`,[txt(`cockpitMetricValue${i}`,'—',{fontSize:'clamp(22px, 2.4vw, 32px)',fontWeight:700,lineHeight:'44px',fontVariantNumeric:'tabular-nums',whiteSpace:'nowrap',wordBreak:'normal',flex:'0 0 auto',color:i===0?'#FFF8ED':C.ink}),note(`cockpitMetricUnit${i}`,m[1],{fontSize:'11px',lineHeight:'20px',whiteSpace:'nowrap',flexShrink:0,color:i===0?'#D9C4B2':C.muted})],{flexDirection:'row',flexWrap:'nowrap',gap:'8px',alignItems:'baseline',marginTop:'4px',width:'100%',maxWidth:'100%',overflowX:'auto',overflowY:'hidden'}),
      note(`cockpitMetricHint${i}`,m[2],{fontSize:'11px',lineHeight:'18px',color:i===0?'#D9C4B2':C.muted,marginTop:'3px'})
    ],{padding:'18px',backgroundColor:i===0?C.ink:C.card,borderColor:i===0?C.ink:C.border},'hl-cockpit-metric')),{display:'grid',gridTemplateColumns:'repeat(6, minmax(0, 1fr))',gap:'12px',marginBottom:'20px'}),
    box('cockpitMembers',[
      card('memberGrowthPanel',[
        heading('memberGrowth','01 / MEMBER GROWTH','会员增长分析','观察会员规模与新增变化，按首次建档日期统计。'),
        plot('memberGrowth','会员增长数据待接入','接入后显示每日新增与累计会员趋势。',[['新增会员',C.primary],['累计会员','#4C6C5E']])
      ]),
      card('memberProfilePanel',[
        heading('memberProfile','MEMBER PROFILE','会员结构与认证','状态指标可重叠，不相加为会员总数。'),
        stateRow('memberVip','有效VIP会员','按当前有效权益计算'),
        stateRow('memberOrdinary','普通会员','当前无有效VIP权益'),
        stateRow('memberVerified','实名认证会员','有效身份认证'),
        stateRow('memberPublic','公开展示会员','已开启展示的有效档案')
      ])
    ],{display:'grid',gridTemplateColumns:'minmax(0, 1.7fr) minmax(280px, 1fr)',gap:'20px',marginBottom:'20px'},'hl-cockpit-grid'),
    box('cockpitRevenue',[
      card('revenueTrendPanel',[
        heading('revenueTrend','02 / CASH COLLECTIONS','经营收款分析','区分实付、退款与净收款，金额单位为元。'),
        plot('revenueTrend','经营收款数据待接入','仅统计已核验交易，排除沙箱与测试订单。',[['实付金额',C.primary],['退款金额','#B98A62'],['净收款','#4C6C5E']]),
        note('revenueAccountingNote','净收款为收款减退款，未扣手续费，不代表会计收入。',{fontSize:'11px',lineHeight:'19px',marginTop:'12px'})
      ]),
      card('revenueMixPanel',[
        heading('revenueMix','PRODUCT MIX','套餐收款构成','按订单成交快照归类，以实付金额计算。'),
        box('revenueMixCanvas',[
          node('revenueMixChart','Pie',{chartType:'ring',dataSourceType:'variable',datasourceVariable:[],isTitle:false,isLegend:false,isSeriesShowSymbol:false,style:{width:'100%',height:'184px',backgroundColor:C.card}}),
          box('revenueMixEmptyRing',[txt('revenueMixValue','—',{fontSize:'28px',lineHeight:'38px',fontWeight:700}),note('revenueMixEmptyLabel','占比待计算',{fontSize:'11px',lineHeight:'18px'})],{position:'absolute',width:'144px',height:'144px',border:`14px solid ${C.soft}`,borderRadius:'50%',alignItems:'center',justifyContent:'center',left:'50%',top:'20px',transform:'translateX(-50%)',pointerEvents:'none'})
        ],{position:'relative',height:'184px',marginTop:'8px'}),
        ...[['VIP会员服务',C.primary],['牵线服务','#4C6C5E']].map((m,i)=>box(`revenueMixRow${i}`,[legend(`revenueMixLegend${i}`,m[0],m[1]),txt(`revenueMixAmount${i}`,'— 元',{fontSize:'13px',lineHeight:'24px',fontWeight:600}),note(`revenueMixShare${i}`,'— %',{fontSize:'12px',lineHeight:'24px'})],{display:'grid',gridTemplateColumns:'minmax(0, 1fr) auto auto',gap:'14px',alignItems:'center',padding:'10px 0px',borderBottom:`1px solid ${C.border}`})),
        note('revenueMixFootnote','明细可按具体套餐展开；缺失快照单独列为待核对。',{fontSize:'11px',lineHeight:'19px',marginTop:'10px'})
      ])
    ],{display:'grid',gridTemplateColumns:'minmax(0, 1.7fr) minmax(280px, 1fr)',gap:'20px',marginBottom:'20px'},'hl-cockpit-grid'),
    card('matchmakerAnalysis',[
      heading('matchmakerAnalysis','03 / PARTNER OPERATIONS','主理人运营分析','结合认证、近期使用与名下会员分布，了解服务覆盖。'),
      box('matchmakerAnalysisBody',[
        box('matchmakerHealth',[
          ...[['审核通过','当前有效主理人'],['待审核','待处理的入驻申请'],['近30天使用','近30天打开过小程序']].map((m,i)=>box(`matchmakerHealth${i}`,[box(`matchmakerHealthCopy${i}`,[txt(`matchmakerHealthLabel${i}`,m[0],{fontSize:'13px',lineHeight:'24px',fontWeight:600}),note(`matchmakerHealthDesc${i}`,m[1],{fontSize:'11px',lineHeight:'18px'})]),txt(`matchmakerHealthValue${i}`,'—',{fontSize:'24px',lineHeight:'34px',fontWeight:700,color:C.primary})],{flexDirection:'row',justifyContent:'space-between',gap:'12px',padding:'14px 16px',borderRadius:'8px',backgroundColor:'#F5ECE2'}))
        ],{gap:'10px'}),
        box('matchmakerRanking',[
          box('matchmakerRankingTitle',[txt('matchmakerRankingLabel','会员服务覆盖',{fontSize:'14px',lineHeight:'24px',fontWeight:600}),note('matchmakerRankingHint','按当前名下会员数排序',{fontSize:'11px',lineHeight:'20px'})],{flexDirection:'row',justifyContent:'space-between',gap:'10px',flexWrap:'wrap',marginBottom:'10px'}),
          box('matchmakerRankScroll',[box('matchmakerRankHeader',['主理人','所在地','名下会员','近30天新增归属'].map((x,i)=>txt(`matchmakerRankColumn${i}`,x,{fontSize:'12px',lineHeight:'22px',fontWeight:600,color:C.muted})),{display:'grid',gridTemplateColumns:'1.25fr 1fr 1fr 1.2fr',gap:'12px',padding:'12px 14px',minWidth:'490px',backgroundColor:'#F4EDE4',borderRadius:'6px'})],{overflowX:'auto',width:'100%'}),
          box('matchmakerRankEmpty',[txt('matchmakerRankEmptyTitle','主理人分析数据待接入',{fontSize:'14px',lineHeight:'24px',fontWeight:600}),note('matchmakerRankEmptyCopy','接入后展示主理人覆盖与会员归属分布。',{fontSize:'12px',lineHeight:'20px',marginTop:'6px'})],{minHeight:'136px',alignItems:'center',justifyContent:'center',textAlign:'center',padding:'20px'}),
          note('matchmakerRankFootnote','所在地取资料填写城市；当前归属不用于回推历史业绩。',{fontSize:'11px',lineHeight:'19px'})
        ])
      ],{display:'grid',gridTemplateColumns:'minmax(200px, .75fr) minmax(0, 1.7fr)',gap:'24px',marginTop:'20px'})
    ],{marginBottom:'20px'}),
    box('cockpitWorkHeadingWrap',[heading('cockpitWork','WORKSPACE','待办与工作入口','从经营观察回到日常处理。')],{marginBottom:'14px'}),
    box('cockpitWorkEntries',pages.slice(1).map((p,i)=>card(`cockpitEntry${i}`,[
      box(`cockpitEntryHead${i}`,[icon(`cockpitEntryIcon${i}`,p.icon),txt(`cockpitEntryTitle${i}`,p.title,{fontSize:'14px',lineHeight:'24px',fontWeight:600})],{flexDirection:'row',alignItems:'center',gap:'10px'}),
      note(`cockpitEntryDetail${i}`,['待审核 —','待认证 —','待审核 —','套餐与权益','支付与履约'][i],{fontSize:'12px',lineHeight:'20px',marginTop:'12px',marginBottom:'14px'}),
      button(`entrance${i}`,'进入',{pageId:p.id,primary:i===0})
    ],{padding:'18px'},'hl-cockpit-entry')),{display:'grid',gridTemplateColumns:'repeat(5, minmax(0, 1fr))',gap:'12px'}),
    note('cockpitDataNote','统计说明：所有“—”表示尚未取得数据，不代表零；周期统计按北京时间。',{fontSize:'11px',lineHeight:'20px',marginTop:'18px'})
  ];
}
