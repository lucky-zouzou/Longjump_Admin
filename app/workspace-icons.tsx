import type { CSSProperties } from "react";

const paths:Record<string,string>={
  overview:"M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  "business-actions":"M9 5H5v16h14V5h-4 M9 3h6v4H9z M8 13l3 3 5-6",
  "cost-profit":"M4 4h16v16H4z M8 8h8 M8 12h3 M8 16h8",
  "sales-targets":"M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l8-8 M16 4h4v4",
  reviews:"M4 3h16v18H4z M8 8h8 M8 12h8 M8 16h5",
  promotions:"M20 4H10L3 11l10 10 7-7z M14 8h.01 M9 14l6-3",
  "after-sales":"M9 4 4 9l5 5 M4 9h10a6 6 0 0 1 0 12h-3",
  "quality-incidents":"M12 3 2 21h20z M12 9v5 M12 17h.01",
  wholesale:"M3 9h18 M5 9v12h14V9 M2 9l3-6h14l3 6 M9 21v-7h6v7",
  sales:"M4 3v18h17 M8 16l4-5 4 2 5-7 M17 6h4v4",
  suggestions:"M12 3a9 9 0 1 0 9 9 M12 7a5 5 0 1 0 5 5 M12 12l8-8 M16 4h4v4",
  inventory:"m3 7 9-4 9 4-9 4z M3 7v10l9 4 9-4V7 M12 11v10 M7 5l10 4",
  receipt:"M4 13v7h16v-7 M12 3v12 M8 11l4 4 4-4",
  monthly:"M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16 M8 14h2 M14 14h2 M8 17h2",
  approval:"m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6",
  fulfillment:"M3 21V9l6 3V7l6 4V3h4v10l2 1v7z M7 16v1 M12 16v1 M17 16v1",
  "production-tracking":"M3 12h4l3-8 4 16 3-8h4",
  batches:"M4 17 2 11l10-3 10 3-2 6 M6 10V5h12v5 M10 5V2h4v3 M2 21q2-4 5-1t5 0 5 0 5-1",
  "new-products":"m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z",
  master:"M3 4h7v7H3z M14 4h7v7h-7z M3 15h7v7H3z M14 15h7v7h-7z",
  users:"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4",
  audit:"M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9 M12 7v5l4 2",
  permissions:"M12 3a9 9 0 1 0 9 9 9 9 0 0 0-9-9 M8 12l3 3 5-6",
  search:"M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  chevron:"m9 5 7 7-7 7",arrow:"M4 12h16 M14 6l6 6-6 6",
  close:"m6 6 12 12 M6 18 18 6",more:"M5 12h.01 M12 12h.01 M19 12h.01",
  logout:"M9 3H4v18h5 M10 12h11 M16 7l5 5-5 5",
};

export default function WorkspaceIcon({name,style}:{name:string;style?:CSSProperties}){
  return <svg className="workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]||paths.overview}/></svg>;
}
