import { cookies } from "next/headers";
import { randomUUID } from "crypto";

export const DEVICE_COOKIE = "sw_device";

export async function deviceToken(): Promise<string> {
  const jar = await cookies();
  let t = jar.get(DEVICE_COOKIE)?.value;
  if (!t) t = randomUUID();
  return t;
}

export async function setDeviceCookie(token: string): Promise<void> {
  const jar = await cookies();
  jar.set(DEVICE_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
}

export function isMarketOpen(now = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

export function freshnessLabel(asOf: string, marketClosed: boolean): { label: string; stale: boolean; text: string } {
  if (marketClosed) return { label: "closed", stale: false, text: "Market closed" };
  const ageS = Math.max(0, (Date.now() - new Date(asOf).getTime()) / 1000);
  if (ageS < 90) return { label: "live", stale: false, text: "Live" };
  if (ageS < 600) return { label: "delayed", stale: false, text: `Delayed ${Math.round(ageS / 60)}m` };
  return { label: "stale", stale: true, text: "Stale" };
}
