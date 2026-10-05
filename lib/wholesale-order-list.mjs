// Used by the list and export after the server has applied account permissions.
export function filterWholesaleOrders(orders,{view="orders",status="all",search=""}={}){
  const query=search.toLowerCase();
  return orders.filter(o=>(view==="completed"?["completed","closed"].includes(o.status):(status==="all"||o.status===status))&&
    [o.order_no,o.customer?.name,o.customer?.phone,o.sales_name,...o.items.map(i=>i.sku)].join(" ").toLowerCase().includes(query));
}
