export async function hashRoutingInfo(routingInfo: string): Promise<string> {
  if (!routingInfo || routingInfo.trim() === "") {
    throw new Error("Routing information cannot be empty");
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(routingInfo.trim());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseTokenAmount(amountStr: string, decimals: number = 7): bigint {
  if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) < 0) {
    throw new Error(`Invalid token amount string: ${amountStr}`);
  }
  const parts = amountStr.trim().split(".");
  const integerPart = parts[0] || "0";
  let fractionalPart = parts[1] || "";

  if (fractionalPart.length > decimals) {
    throw new Error(`Amount exceeds maximum supported decimals (${decimals})`);
  }

  fractionalPart = fractionalPart.padEnd(decimals, "0");
  const fullStr = integerPart + fractionalPart;
  return BigInt(fullStr);
}
