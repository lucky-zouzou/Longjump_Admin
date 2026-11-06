"use client";
import {Fragment, useMemo, useState} from "react";
import DistributorLink from "./distributor-link";
import {useWholesaleLanguage} from "./wholesale-language";
import {customerProfiles, portfolioTotals} from "../lib/wholesale-customer-profiles.mjs";

// Joined rows come from the permission-scoped wholesale workspace.
type Row = Record<string, any>;
type Group = "customer" | "region" | "city" | "owner";
const areaKey = (value: string) => (value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("id");
const pageSize = 20;

export default function CustomerProfiles({data, canManage, refresh}:{
  data: Row; canManage: boolean; refresh: () => Promise<unknown>;
}) {
  const {language, money, fmt} = useWholesaleLanguage();
  const say = (zh: string, id: string) => language === "id" ? id : zh;
  const [group, setGroup] = useState<Group>("customer");
  const [query, setQuery] = useState(""), [region, setRegion] = useState<string|null>(null);
  const [city, setCity] = useState<string|null>(null), [owner, setOwner] = useState<string|null>(null);
  const [stage, setStage] = useState(""), [sort, setSort] = useState<"netSales"|"netSoldQty">("netSales");
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState("");
  const portfolio = useMemo(() => customerProfiles(data.customers, data.orders, data.finance), [data]);
  const regions = new Map<string,string>(), cities = new Map<string,string>(), owners = new Map<string,string>();
  const unknownArea = say("待划分", "Belum ditentukan");
  for (const {customer: c} of portfolio.rows) {
    regions.set(areaKey(c.region), c.region || unknownArea);
    if (region === null || areaKey(c.region) === region) cities.set(areaKey(c.city), c.city);
    owners.set(c.sales_user_id, c.owner_name || c.sales_user_id);
  }
  const stages: Record<string,string> = {
    prospect: say("待首购", "Belum membeli"), first: say("首购客户", "Pembeli pertama"),
    repeat: say("复购客户", "Pembeli berulang"), later: say("期后建档","Terdaftar setelah periode"),
  };
  const scope = portfolio.rows.filter(row => {
    const c = row.customer;
    return (region === null || areaKey(c.region) === region) && (city === null || areaKey(c.city) === city)
      && (owner === null || c.sales_user_id === owner) && (!stage || row.segment === stage)
      && [c.name,c.code,c.contact,c.phone].some(value => String(value ?? "").toLowerCase().includes(query.trim().toLowerCase()));
  }).sort((a,b) => b[sort] - a[sort] || a.customer.code.localeCompare(b.customer.code));
  const totals = portfolioTotals(scope);
  const grouped = new Map<string, typeof scope>();
  if (group !== "customer") for (const row of scope) {
    const key = group === "owner" ? row.customer.sales_user_id : areaKey(row.customer[group]);
    const members = grouped.get(key);
    if (members) members.push(row); else grouped.set(key,[row]);
  }
  const groups = Array.from(grouped, ([key, rows]) => ({key, ...portfolioTotals(rows)})).sort((a,b) => b[sort]-a[sort] || a.key.localeCompare(b.key));
  const count = group === "customer" ? scope.length : groups.length;
  const pages = Math.ceil(count/pageSize), current = Math.min(page, Math.max(0,pages-1));
  const slice = <T,>(list: T[]) => list.slice(current*pageSize,(current+1)*pageSize);
  const share = (amount:number) => portfolio.totalSales > 0
    ? (amount / portfolio.totalSales).toLocaleString(language === "id" ? "id-ID" : "zh-CN", {style:"percent",maximumFractionDigits:1}) : "—";
  const picker = (label:string, options:Map<string,string>, value:string|null, change:(v:string|null)=>void) =>
    <label className="wh-field"><span>{label}</span><select value={value === null ? "*" : "="+value}
      onChange={e=>{change(e.target.value==="*" ? null : e.target.value.slice(1));setPage(0);}}>
      <option value="*">{say("全部","Semua")}</option>
      {Array.from(options).sort((a,b)=>a[1].localeCompare(b[1])).map(([k,v])=><option key={k} value={"="+k}>{v}</option>)}
    </select></label>;
  const modes: Record<Group,string> = {customer:say("按客户","Per pelanggan"),region:say("按区域","Per wilayah"),city:say("按城市","Per kota"),owner:say("按维护销售","Per penanggung jawab")};
  const labels = {region:say("业务区域","Wilayah penjualan"), city:say("城市","Kota"), owner:say("维护销售","Penanggung jawab"),
    sales:say("净销售额","Penjualan neto"), qty:say("净销量","Unit terjual neto"), receipts:say("订单净回款","Penerimaan neto pesanan")};
  return <div className="wh-portfolio">
    <h5>{say("线下渠道客户画像","Profil pelanggan grosir")}</h5>
    <p className="wh-copy">{data.finance.start} — {data.finance.cutoff} · {say("归属按当前维护销售，金额单位为印尼盾。","Portofolio menurut penanggung jawab saat ini. Seluruh nilai dalam IDR.")}</p>
    <div className="wh-profile-filters">
      <label className="wh-field"><span>{say("搜索客户","Cari pelanggan")}</span><input type="search" value={query}
        placeholder={say("名称、编号或电话","Nama, kode, atau telepon")} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
      {picker(labels.region,regions,region,v=>{setRegion(v);setCity(null);})}
      {picker(labels.city,cities,city,setCity)}
      {picker(labels.owner,owners,owner,setOwner)}
      {picker(say("购买阶段","Tahap pembelian"),new Map(Object.entries(stages)),stage || null,v=>setStage(v||""))}
    </div>
    <div className="wh-profile-metrics">
      {[[say("筛选内客户","Pelanggan terpilih"),fmt(totals.count)],[labels.sales,money(totals.netSales)],
        [labels.qty,fmt(totals.netSoldQty)],[labels.receipts,money(totals.netReceipts)]].map(([label,value])=>
        <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
    </div>
    <div className="wh-profile-bar"><div className="wh-tabs" role="group" aria-label={say("汇总方式","Kelompokkan menurut")}>
      {(Object.keys(modes) as Group[]).map(key=><button type="button" aria-pressed={key===group} className={group===key?"active":""}
        key={key} onClick={()=>{setGroup(key);setPage(0);}}>{modes[key]}</button>)}</div>
      <label>{say("排序","Urutkan")} <select value={sort} onChange={e=>{setSort(e.target.value as typeof sort);setPage(0);}}>
        <option value="netSales">{say("净销售额从高到低","Penjualan neto tertinggi")}</option><option value="netSoldQty">{say("净销量从高到低","Unit neto terbanyak")}</option>
      </select></label></div>
    <div className="table-wrap"><table><thead><tr>
      <th>{group==="customer"?say("客户","Pelanggan"):labels[group]}</th>
      <th>{group==="customer"?say("地区 / 维护销售","Wilayah / penanggung jawab"):say("客户数","Jumlah pelanggan")}</th>
      <th>{labels.qty}</th><th>{labels.sales}</th><th>{say("销售贡献占比","Kontribusi penjualan")}</th><th>{labels.receipts}</th>
    </tr></thead><tbody>
      {group==="customer" ? slice(scope).map(row=>{
        const c=row.customer, open=expanded===c.id;
        return <Fragment key={c.id}><tr>
          <td><button type="button" className="wh-profile-name" aria-expanded={open} onClick={()=>setExpanded(open?"":c.id)}>{c.name}</button>
            <small>{c.code} · {stages[row.segment]}{!c.active ? " · "+say("已停用","Nonaktif") : ""}</small></td>
          <td>{[c.region || unknownArea,c.city].filter(Boolean).join(" / ")}<small>{owners.get(c.sales_user_id)}</small></td>
          <td>{fmt(row.netSoldQty)}</td><td>{money(row.netSales)}</td><td>{share(row.netSales)}</td><td>{money(row.netReceipts)}</td>
        </tr>{open && <tr className="wh-profile-details"><td colSpan={6}><div>
          <span>{say("联系人","Kontak")} <strong>{c.contact} · {c.phone}</strong></span>
          <span>{say("收货地址","Alamat pengiriman")} <strong>{c.address}</strong></span>
          <span>{say("截至期末的有效成交订单","Pesanan dengan unit neto positif s.d. akhir periode")} <strong>{fmt(row.purchases)}</strong></span>
          <span>{say("最近正向成交日","Tanggal penjualan positif terakhir")} <strong>{row.lastSale || "—"}</strong></span>
          <span>{say("期末应收","Piutang akhir periode")} <strong>{money(row.receivable)}</strong></span>
          <span>{say("当前订单数 / 合同待收款","Pesanan saat ini / sisa tagihan kontrak")} <strong>{fmt(row.orderCount)} / {money(row.currentOutstanding)}</strong></span>
          {canManage && Boolean(c.active || c.distributor_active) && <DistributorLink customerId={c.id} active={Boolean(c.distributor_active)} version={c.distributor_version} refresh={refresh}/>}
        </div></td></tr>}</Fragment>;
      }) : slice(groups).map(row=><tr key={row.key}><td><button type="button" className="wh-profile-name" onClick={()=>{
        if(group==="region"){setRegion(row.key);setCity(null);}else if(group==="city")setCity(row.key);else setOwner(row.key);setGroup("customer");setPage(0);
      }}>{(group==="region"?regions:group==="city"?cities:owners).get(row.key)}</button></td><td>{fmt(row.count)}</td>
        <td>{fmt(row.netSoldQty)}</td><td>{money(row.netSales)}</td><td>{share(row.netSales)}</td><td>{money(row.netReceipts)}</td></tr>)}
      {count===0&&<tr><td colSpan={6}>{say("当前条件下没有客户。","Tidak ada pelanggan yang cocok.")}</td></tr>}
    </tbody></table></div>
    {pages>1 && <div className="wh-actions"><button className="btn" disabled={current===0} onClick={()=>setPage(current-1)}>{say("上一页","Sebelumnya")}</button>
      <span>{current+1} / {pages}</span><button className="btn" disabled={current+1===pages} onClick={()=>setPage(current+1)}>{say("下一页","Berikutnya")}</button></div>}
    <details className="wh-profile-legend"><summary>{say("统计口径","Dasar perhitungan")}</summary>
      <p>{say("现金类按实际出库，寄售按财务确认已售，扣除对应退货及冲正。订单净回款只计已核销到订单的金额。","Penjualan tunai mengikuti pengiriman aktual, konsinyasi mengikuti konfirmasi barang terjual. Retur terkait dan koreksi mengurangi hasil. Penerimaan hanya mencakup dana yang dialokasikan ke pesanan.")}</p>
      <p>{say("贡献占比按客户本月净销售额占权限内全部客户本月净销售额计算。筛选不改变分母，合计小于或等于零时显示横线。购买阶段按截至期末仍有净销量的历史订单数划分为 0 笔、1 笔、2 笔及以上。","Kontribusi adalah bagian penjualan neto bulan ini dari semua pelanggan yang dapat Anda lihat, dengan penyebut tetap meski difilter. Jika total tidak positif, tampil tanda pisah. Tahap pembelian dihitung dari 0, 1, atau minimal 2 pesanan historis dengan unit neto positif hingga akhir periode.")}</p>
    </details>
  </div>;
}
