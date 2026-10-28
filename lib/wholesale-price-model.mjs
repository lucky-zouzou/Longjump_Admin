// Integer minor units and basis points prevent floating point underpricing.
export function markedPrice(costMinor,markupBp,rounding=100){
 if(!Number.isSafeInteger(costMinor)||costMinor<=0||!Number.isSafeInteger(markupBp)||markupBp<0||!Number.isSafeInteger(rounding)||rounding<=0){throw new Error('成本或加成率超出允许范围');};
 const numerator=BigInt(costMinor)*(10000n+BigInt(markupBp)),step=1000000n*BigInt(rounding);
 return Number((numerator+step-1n)/step)*rounding;
}
