import type { CookieOptions, Request, Response } from "express";

const production = process.env.NODE_ENV === "production";

export const REFRESH_COOKIE_NAME = production
  ? "__Host-oriva_refresh"
  : "oriva_refresh";

const options: CookieOptions = {
  httpOnly: true,
  secure: production,
  sameSite: "lax",
  path: "/",
};

export function readRefreshCookie(req: Request): string | undefined {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  return typeof token === "string" ? token : undefined;
}

export function setRefreshCookie(
  res: Response,
  token: string,
  expiresAt: Date,
) {
  res.set("Cache-Control", "no-store");
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...options,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response) {
  res.set("Cache-Control", "no-store");
  res.clearCookie(REFRESH_COOKIE_NAME, options);
}