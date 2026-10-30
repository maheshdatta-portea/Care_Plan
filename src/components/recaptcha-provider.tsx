"use client";

// Loads the reCAPTCHA v3 script when a site key is configured. Renders nothing
// and does nothing until NEXT_PUBLIC_RECAPTCHA_SITE_KEY is set, so it is safe to
// ship before the keys exist.

import Script from "next/script";

export function RecaptchaProvider() {
  const key = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  if (!key) return null;
  return (
    <Script
      src={`https://www.google.com/recaptcha/api.js?render=${key}`}
      strategy="afterInteractive"
    />
  );
}
