const TIP_PERCENTAGES = new Set([10, 15, 20])

function roundMoney(value) {
  return Number((Math.round(Number(value || 0) * 100) / 100).toFixed(2))
}

export function normalizeTip({ tipsEnabled, subtotal, tipAmount, tipType, tipPercentage }) {
  if (!tipsEnabled) {
    return { tipAmount: 0, tipType: null, tipPercentage: null }
  }

  const requestedAmount = roundMoney(tipAmount)
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    return { tipAmount: 0, tipType: null, tipPercentage: null }
  }

  if (tipType === "percentage") {
    const percentage = Number(tipPercentage)
    if (!TIP_PERCENTAGES.has(percentage)) {
      return { tipAmount: 0, tipType: null, tipPercentage: null }
    }

    return {
      tipAmount: roundMoney(Number(subtotal || 0) * (percentage / 100)),
      tipType: "percentage",
      tipPercentage: percentage,
    }
  }

  if (tipType === "custom") {
    return { tipAmount: requestedAmount, tipType: "custom", tipPercentage: null }
  }

  return { tipAmount: 0, tipType: null, tipPercentage: null }
}

export function amountExcludingTip(order) {
  return roundMoney(Number(order?.total || 0) - Number(order?.tipAmount || 0))
}
