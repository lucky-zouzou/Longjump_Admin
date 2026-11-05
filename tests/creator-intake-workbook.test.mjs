import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from 'xlsx';
import {readFileSync} from 'node:fs';
import {readIntakeWorkbook} from '../lib/creator-intake-workbook.mjs';
import {intakeHeaders,intakeDate,mapIntakeRow,normalizeIntake} from '../lib/creator-intake-model.mjs';

function workbook({date=46330,date1904=false,rows=1}={}){
 const book=X.utils.book_new(),sheet=X.utils.aoa_to_sheet([intakeHeaders,...Array.from({length:rows},()=>[date,'2026-11','印尼','@synthetic.creator','https://example.test/creator','test@example.test','TEST-BAG / TEST-SAMPLE','视频','纯佣',50000,18,12800.25,26000,'出单不勤快','A-优质','真人出镜+产品展示，不口播,会自己根据产品创作'])]);
 if(rows){sheet.A2.z='m/d/yy';sheet.J2.z='#,##0';sheet.L2.z='#,##0.0';}
 X.utils.book_append_sheet(book,sheet,'运营达人协同提交模板');book.Workbook={WBProps:{date1904}};
 return X.write(book,{type:'buffer',bookType:'xlsx'});
}

test('company 16-column workbook reads typed dates and exact amounts instead of Excel display text',()=>{
 const input=workbook(),display=X.read(input,{cellDates:true});
 assert.equal(X.utils.sheet_to_json(display.Sheets[display.SheetNames[0]],{raw:false})[0]['创建日期'],'11/4/26');
 const {rows}=readIntakeWorkbook(X,input),data=normalizeIntake(mapIntakeRow(rows[0],{scopeId:'test',currency:'IDR',qualified:true}),'2026-11-04');
 assert.equal(data.submittedOn,'2026-11-04');assert.equal(data.month,'2026-11');assert.equal(data.sampledProducts,'TEST-BAG / TEST-SAMPLE');
 assert.equal(data.followers,50000);assert.equal(data.orders,18);assert.equal(data.gmvMinor,1280025);assert.equal(data.currency,'IDR');assert.equal(data.grade,'A');assert.equal(data.styles.length,2);
 assert.throws(()=>normalizeIntake(mapIntakeRow(rows[0],{scopeId:'test',qualified:true}),'2026-11-04'),/原币种/);
});

test('1904-date workbooks and unambiguous CSV dates keep the same calendar day',()=>{
 assert.equal(readIntakeWorkbook(X,workbook({date:46330-1462,date1904:true})).rows[0]['创建日期'],'2026-11-04');
 const csv='\uFEFF创建日期,达人id,近30天有效订单,粉丝数\r\n2026/11/4,test,0,\r\n';
 const row=readIntakeWorkbook(X,new TextEncoder().encode(csv)).rows[0];
 assert.equal(intakeDate(row['创建日期']),'2026-11-04');assert.equal(row['近30天有效订单'],'0');assert.equal(row['粉丝数'],'');
 assert.throws(()=>intakeDate('11/4/26'),/日期/);assert.throws(()=>intakeDate('2026/2/30'),/日期/);
});

test('company download retains its 16-column layout, date formatting and illustrative row',()=>{
 const input=readFileSync(new URL('../public/templates/creator-operations-handover.xlsx',import.meta.url));
 const book=X.read(input),grid=X.utils.sheet_to_json(book.Sheets['运营达人协同提交模板'],{header:1});
 assert.deepEqual(grid[0],['创建日期','月份','国家','达人id','TK主页链接','达人联系方式','已寄样产品','达人类型','合作方式','粉丝数','近30天有效订单','近30天GMV（元）','平均播放量','达人分类','运营评估等级','视频风格/视频类型评估（多选，逗号分隔）']);
 assert.equal(grid.length,2);assert.equal(grid[1][3],'@creator.id');
 assert.equal(readIntakeWorkbook(X,input).rows[0]['创建日期'],'2026-11-04');
});

test('import rejects missing or repeated ID headers and oversized batches before any submission',()=>{
 assert.throws(()=>readIntakeWorkbook(X,new TextEncoder().encode('创建日期,名称\n2026-11-04,test')),/ID/);
 assert.throws(()=>readIntakeWorkbook(X,new TextEncoder().encode('达人id,达人id\na,b')),/重复/);
 assert.throws(()=>readIntakeWorkbook(X,workbook({rows:51})),/1至50/);
 assert.equal(readIntakeWorkbook(X,workbook({rows:50})).rows.length,50);
 const gaps=readIntakeWorkbook(X,new TextEncoder().encode('达人id,创建日期\na,2026-11-04\n,\nb,2026-11-04'));
 assert.deepEqual(gaps.rows.map(r=>r.__sourceRow),[2,4]);
});

test('blank sample products preserve old normalized fingerprint input and missing metrics stay distinct from zero',()=>{
 const base={submittedOn:'2026-11-04',platformId:'test',profileUrl:'https://example.test/creator'};
 assert.equal(JSON.stringify(normalizeIntake(base,'2026-11-04')),JSON.stringify(normalizeIntake({...base,sampledProducts:'  '},'2026-11-04')));
 assert.equal(Object.hasOwn(normalizeIntake(base,'2026-11-04'),'sampledProducts'),false);
 assert.equal(normalizeIntake(base,'2026-11-04').orders,null);assert.equal(normalizeIntake({...base,orders:0},'2026-11-04').orders,0);
});
