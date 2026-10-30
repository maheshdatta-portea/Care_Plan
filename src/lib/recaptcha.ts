// Client-side reCAPTCHA v3 token helper. Returns undefined (so submission still
// works) when reCAPTCHA is not configured or the script has not loaded, letting
// the server decide whether to enforce.

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

export function getRecaptchaToken(action: string): Promise<string | undefined> {
  const key = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY;
  return new Promise((resolve) => {
    if (!key || typeof window === "undefined" || !window.grecaptcha) {
      resolve(undefined);
      return;
    }
    try {
      window.grecaptcha.ready(() => {
        window
          .grecaptcha!.execute(key, { action })
          .then(resolve)
          .catch(() => resolve(undefined));
      });
    } catch {
      resolve(undefined);
    }
  });
}
