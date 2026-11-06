// Customer portfolios use current service ownership and the existing IDR reconciliation.
export function customerProfiles(customers, orders, finance) {
  const profiles = new Map(customers.map(customer => [customer.id, {
    customer, netSales: 0, netSoldQty: 0, netReceipts: 0, receivable: 0,
    purchases: 0, lastSale: "", orderCount: 0, currentOutstanding: 0,
  }]));
  const monthly = new Map(finance.rows.map(row => [row.id, row]));
  for (const order of orders) {
    const profile = profiles.get(order.customer_id);
    if (!profile) continue;
    profile.orderCount++;
    profile.currentOutstanding += order.outstanding;
    const row = monthly.get(order.id);
    if (!row) continue;
    profile.netSales += row.netSales;
    profile.netSoldQty += row.netSoldQty;
    profile.netReceipts += row.netReceipts;
    profile.receivable += row.closingReceivable;
    // A fully returned or reversed order does not qualify the account as a repeat buyer.
    if (row.closingNetSoldQty <= 0) continue;
    profile.purchases++;
    const sales = order.sale_type === "consignment" ? order.consignmentSales : order.shipments;
    for (const sale of sales) {
      if (sale.business_date <= finance.cutoff && sale.business_date > profile.lastSale &&
          (order.sale_type !== "consignment" || sale.qty > 0)) profile.lastSale = sale.business_date;
    }
  }
  const rows = Array.from(profiles.values());
  const totalSales = rows.reduce((sum, row) => sum + row.netSales, 0);
  return {
    totalSales,
    rows: rows.map(row => ({
      ...row, segment: purchaseStage(row, finance.cutoff),
    })),
  };
}

export function portfolioTotals(rows) {
  return rows.reduce((sum, row) => {
    sum.count++;
    sum.netSales += row.netSales;
    sum.netSoldQty += row.netSoldQty;
    sum.netReceipts += row.netReceipts;
    sum.receivable += row.receivable;
    return sum;
  }, {count: 0, netSales: 0, netSoldQty: 0, netReceipts: 0, receivable: 0});
}

function purchaseStage(row, cutoff) {
  if (row.purchases > 1) return "repeat";
  if (row.purchases === 1) return "first";
  const created = Date.parse(row.customer.created_at);
  if (Number.isFinite(created) && new Date(created + 7*3600000).toISOString().slice(0,10) > cutoff) return "later";
  return "prospect";
}
